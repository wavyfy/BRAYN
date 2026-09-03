import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { DomainEvent } from '../../common/events/domain-event';
import { CustomerService } from '../commerce/customer.service';
import { ProductService } from '../commerce/product.service';
import { OrderService } from '../commerce/order.service';
import { CollectionService } from '../commerce/collection.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { IntegrationService } from './integration.service';
import { ProviderRegistry } from './provider-registry.service';
import type { IntegrationProvider } from './dto/connect-integration.schema';
import type { FetchOptions, ProviderAdapter } from './provider-adapter.interface';

export interface SyncRequestedPayload {
  provider: IntegrationProvider;
  /** ISO timestamp — Shopify's `updated_at_min` cursor for this pass (doc 06/20 — Incremental Synchronization). */
  updatedAtMin: string;
}

/**
 * Drives the incremental-sync pagination loop (doc 06 — "After initial
 * import, changes are processed through the provider's supported
 * mechanisms": webhooks first, this as the catch-up mechanism "where
 * required", reconciliation as the last-resort consistency check). Reacts
 * to `integration.sync.requested`, same event/job boundary
 * ImportProcessorService sits behind for imports.
 *
 * Unlike ReconciliationProcessorService, no BRAYN-side diffing happens
 * here — `updatedAtMin` is passed straight to the provider's own filter
 * (doc 20 Shopify: `updated_at_min`), so every record a page returns is,
 * by the provider's own definition, something that changed. Apply it the
 * same idempotent way import/webhooks/reconciliation already do.
 *
 * Unlike ImportProcessorService, a page failure here fails the whole pass
 * rather than being tolerated and counted: this is a small, frequent
 * catch-up run (not a one-time backfill), so a clear failed/retry signal
 * on `integrations.status` is more useful than a partially-applied
 * "success" — and re-running is safe, since every apply is idempotent.
 */
@Injectable()
export class SyncProcessorService {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly integrationService: IntegrationService,
    private readonly customerService: CustomerService,
    private readonly productService: ProductService,
    private readonly orderService: OrderService,
    private readonly collectionService: CollectionService,
    private readonly identityResolutionService: IdentityResolutionService,
  ) {}

  @OnEvent('integration.sync.requested')
  async handleSyncRequested(event: DomainEvent<SyncRequestedPayload>): Promise<void> {
    const workspaceId = event.workspaceId;
    const integrationId = event.entityId;
    const { provider, updatedAtMin } = event.payload;
    if (!workspaceId || !integrationId) {
      return;
    }

    const credentials = await this.integrationService.getCredentials(workspaceId, provider);
    if (!credentials) {
      await this.integrationService.failSync(workspaceId, provider, 'No credentials stored for this provider.');
      return;
    }

    const adapter = this.providerRegistry.get(provider);
    const options: FetchOptions = { updatedAtMin: new Date(updatedAtMin) };

    try {
      if (adapter.fetchCustomers) {
        await this.syncCustomers(adapter, credentials, workspaceId, integrationId, provider, options);
      }
      if (adapter.fetchProducts) {
        await this.syncProducts(adapter, credentials, workspaceId, integrationId, provider, options);
      }
      if (adapter.fetchOrders) {
        await this.syncOrders(adapter, credentials, workspaceId, integrationId, provider, options);
      }
      if (adapter.fetchCollections) {
        await this.syncCollections(adapter, credentials, workspaceId, integrationId, provider, options);
      }
      // Collect (membership) is deliberately not synced incrementally: no
      // `updated_at` field to filter on and no webhook (see
      // CollectionService's doc comment), so re-fetching it every sync pass
      // would mean re-walking the whole shop-wide list every time. Left to
      // reconciliation, the heavier full-recheck mechanism doc 06 already
      // distinguishes sync from.

      await this.integrationService.completeSync(workspaceId, provider);
    } catch (error) {
      await this.integrationService.failSync(workspaceId, provider, error instanceof Error ? error.message : 'Unknown sync error.');
    }
  }

  private async syncCustomers(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    options: FetchOptions,
  ): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await adapter.fetchCustomers!(credentials, cursor, options);
      await this.customerService.upsertMany(workspaceId, integrationId, provider, page.customers);
      await this.identityResolutionService.resolveMany(workspaceId, provider, page.customers.map((c) => c.externalId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  private async syncProducts(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    options: FetchOptions,
  ): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await adapter.fetchProducts!(credentials, cursor, options);
      await this.productService.upsertMany(workspaceId, integrationId, provider, page.products);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  private async syncOrders(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    options: FetchOptions,
  ): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await adapter.fetchOrders!(credentials, cursor, options);
      await this.orderService.upsertMany(workspaceId, integrationId, provider, page.orders);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  private async syncCollections(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    options: FetchOptions,
  ): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await adapter.fetchCollections!(credentials, cursor, options);
      await this.collectionService.upsertMany(workspaceId, integrationId, provider, page.collections);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
}
