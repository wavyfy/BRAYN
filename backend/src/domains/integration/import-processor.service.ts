import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { DomainEvent } from '../../common/events/domain-event';
import { CustomerService } from '../commerce/customer.service';
import { ProductService } from '../commerce/product.service';
import { OrderService } from '../commerce/order.service';
import { CollectionService } from '../commerce/collection.service';
import { ImportRunService } from './import-run.service';
import { IntegrationService } from './integration.service';
import { ProviderRegistry } from './provider-registry.service';
import type { IntegrationProvider } from './dto/connect-integration.schema';
import type { ProviderAdapter } from './provider-adapter.interface';

export interface ImportRequestedPayload {
  provider: IntegrationProvider;
  runId: string;
}

/**
 * Drives the initial-import pagination loop (doc 06/20 — Initial Import:
 * pagination, progress tracking, partial-failure handling, completion
 * state). Reacts to `integration.import.requested` off the request that
 * triggered it (doc 07 — event/job, not direct call, since this is
 * long-running and talks to an external system).
 *
 * One run covers every resource type the adapter supports — customers,
 * products, then orders, imported sequentially in that order because
 * orders link to customer/variant rows (doc 20 — "Required customer/order
 * relationships") that must already exist for the linkage to resolve.
 * ImportRunService models "one row per initial-import attempt for an
 * integration", not per entity type, and doc 19's Visible Result is one
 * merchant-facing import/sync progress, not several.
 *
 * ponytail: `cursor` tracks only the resource currently being paginated —
 * a run that fails mid-products still restarts customers from page 1 on
 * retry (upserts are idempotent, so this is wasted work, not wrong data).
 * True per-resource resumability is deferred to the "Retry/error handling"
 * part (doc 19), once retry itself exists.
 *
 * ponytail: a page whose upsert throws counts every record on that page as
 * failed rather than isolating which record broke — per-record partial
 * failure needs re-fetching/re-validating individually, add when a real
 * provider payload demonstrates it's needed.
 */
@Injectable()
export class ImportProcessorService {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly importRunService: ImportRunService,
    private readonly integrationService: IntegrationService,
    private readonly customerService: CustomerService,
    private readonly productService: ProductService,
    private readonly orderService: OrderService,
    private readonly collectionService: CollectionService,
  ) {}

  @OnEvent('integration.import.requested')
  async handleImportRequested(event: DomainEvent<ImportRequestedPayload>): Promise<void> {
    const workspaceId = event.workspaceId;
    const integrationId = event.entityId;
    const { provider, runId } = event.payload;
    if (!workspaceId || !integrationId) {
      await this.importRunService.failImportRun(runId, 'Import event was missing workspace or integration context.');
      return;
    }

    const credentials = await this.integrationService.getCredentials(workspaceId, provider);
    if (!credentials) {
      await this.importRunService.failImportRun(runId, 'No credentials stored for this provider.');
      return;
    }

    const adapter = this.providerRegistry.get(provider);
    let imported = 0;
    let failed = 0;

    try {
      if (adapter.fetchCustomers) {
        ({ imported, failed } = await this.importCustomers(adapter, credentials, workspaceId, integrationId, provider, runId, imported, failed));
      }
      if (adapter.fetchProducts) {
        ({ imported, failed } = await this.importProducts(adapter, credentials, workspaceId, integrationId, provider, runId, imported, failed));
      }
      if (adapter.fetchOrders) {
        ({ imported, failed } = await this.importOrders(adapter, credentials, workspaceId, integrationId, provider, runId, imported, failed));
      }
      if (adapter.fetchCollections) {
        ({ imported, failed } = await this.importCollections(adapter, credentials, workspaceId, integrationId, provider, runId, imported, failed));
      }
      // Depends on both products and collections already existing (doc 20 — "Required customer/order relationships").
      if (adapter.fetchCollects) {
        ({ imported, failed } = await this.importCollects(adapter, credentials, workspaceId, integrationId, provider, runId, imported, failed));
      }

      await this.importRunService.completeImportRun(runId);
    } catch (error) {
      await this.importRunService.failImportRun(runId, error instanceof Error ? error.message : 'Unknown import error.');
    }
  }

  private async importCustomers(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    runId: string,
    startImported: number,
    startFailed: number,
  ): Promise<{ imported: number; failed: number }> {
    let cursor: string | undefined;
    let imported = startImported;
    let failed = startFailed;

    do {
      const page = await adapter.fetchCustomers!(credentials, cursor);
      try {
        imported += await this.customerService.upsertMany(workspaceId, integrationId, provider, page.customers);
      } catch {
        failed += page.customers.length;
      }
      cursor = page.nextCursor ?? undefined;
      await this.importRunService.recordProgress(runId, { recordsImported: imported, recordsFailed: failed, cursor });
    } while (cursor);

    return { imported, failed };
  }

  private async importProducts(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    runId: string,
    startImported: number,
    startFailed: number,
  ): Promise<{ imported: number; failed: number }> {
    let cursor: string | undefined;
    let imported = startImported;
    let failed = startFailed;

    do {
      const page = await adapter.fetchProducts!(credentials, cursor);
      try {
        const result = await this.productService.upsertMany(workspaceId, integrationId, provider, page.products);
        imported += result.productsWritten;
      } catch {
        failed += page.products.length;
      }
      cursor = page.nextCursor ?? undefined;
      await this.importRunService.recordProgress(runId, { recordsImported: imported, recordsFailed: failed, cursor });
    } while (cursor);

    return { imported, failed };
  }

  private async importOrders(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    runId: string,
    startImported: number,
    startFailed: number,
  ): Promise<{ imported: number; failed: number }> {
    let cursor: string | undefined;
    let imported = startImported;
    let failed = startFailed;

    do {
      const page = await adapter.fetchOrders!(credentials, cursor);
      try {
        const result = await this.orderService.upsertMany(workspaceId, integrationId, provider, page.orders);
        imported += result.ordersWritten;
      } catch {
        failed += page.orders.length;
      }
      cursor = page.nextCursor ?? undefined;
      await this.importRunService.recordProgress(runId, { recordsImported: imported, recordsFailed: failed, cursor });
    } while (cursor);

    return { imported, failed };
  }

  private async importCollections(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    runId: string,
    startImported: number,
    startFailed: number,
  ): Promise<{ imported: number; failed: number }> {
    let cursor: string | undefined;
    let imported = startImported;
    let failed = startFailed;

    do {
      const page = await adapter.fetchCollections!(credentials, cursor);
      try {
        imported += await this.collectionService.upsertMany(workspaceId, integrationId, provider, page.collections);
      } catch {
        failed += page.collections.length;
      }
      cursor = page.nextCursor ?? undefined;
      await this.importRunService.recordProgress(runId, { recordsImported: imported, recordsFailed: failed, cursor });
    } while (cursor);

    return { imported, failed };
  }

  private async importCollects(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    runId: string,
    startImported: number,
    startFailed: number,
  ): Promise<{ imported: number; failed: number }> {
    let cursor: string | undefined;
    let imported = startImported;
    let failed = startFailed;

    do {
      const page = await adapter.fetchCollects!(credentials, cursor);
      try {
        imported += await this.collectionService.upsertCollects(workspaceId, integrationId, provider, page.collects);
      } catch {
        failed += page.collects.length;
      }
      cursor = page.nextCursor ?? undefined;
      await this.importRunService.recordProgress(runId, { recordsImported: imported, recordsFailed: failed, cursor });
    } while (cursor);

    return { imported, failed };
  }
}
