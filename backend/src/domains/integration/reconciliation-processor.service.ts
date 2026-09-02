import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { DomainEvent } from '../../common/events/domain-event';
import { CustomerService } from '../commerce/customer.service';
import { ProductService } from '../commerce/product.service';
import { OrderService } from '../commerce/order.service';
import { CollectionService } from '../commerce/collection.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { ReconciliationRunService } from './reconciliation-run.service';
import { IntegrationService } from './integration.service';
import { ProviderRegistry } from './provider-registry.service';
import type { IntegrationProvider } from './dto/connect-integration.schema';
import type { ProviderAdapter } from './provider-adapter.interface';

export interface ReconciliationRequestedPayload {
  provider: IntegrationProvider;
  runId: string;
}

interface ReconcileCounts {
  checked: number;
  found: number;
  repaired: number;
}

/**
 * Drives the reconciliation pagination loop (doc 06/20 — Reconciliation:
 * detect missing/changed records against provider state, then repair them).
 * Reacts to `integration.reconciliation.requested`, same event/job boundary
 * ImportProcessorService sits behind for imports — this is the same
 * paginated walk over the provider's current state, except each record is
 * first compared against what BRAYN already has before being (re-)applied.
 *
 * "Repair" reuses the exact upsertMany() import/webhooks already use — doc
 * 20 Idempotency explicitly calls out reconciliation alongside repeated
 * imports as callers that must not create duplicates, and an idempotent
 * upsert already satisfies "repairable without corrupting canonical data"
 * whether or not a record actually changed.
 *
 * ponytail: "detect" is scoped to missing + changed records (comparing
 * `sourceUpdatedAt`) — the two categories a REST list endpoint can actually
 * surface. Duplicate-record and deep state-mismatch detection from doc 20's
 * list aren't reachable through Shopify's list APIs the same way; add if a
 * real provider payload demonstrates the gap.
 * ponytail: a page whose upsert throws counts its discrepancies as found
 * but not repaired (mirrors ImportProcessorService's per-page failure
 * handling) rather than isolating which record broke.
 */
@Injectable()
export class ReconciliationProcessorService {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly reconciliationRunService: ReconciliationRunService,
    private readonly integrationService: IntegrationService,
    private readonly customerService: CustomerService,
    private readonly productService: ProductService,
    private readonly orderService: OrderService,
    private readonly collectionService: CollectionService,
    private readonly identityResolutionService: IdentityResolutionService,
  ) {}

  @OnEvent('integration.reconciliation.requested')
  async handleReconciliationRequested(event: DomainEvent<ReconciliationRequestedPayload>): Promise<void> {
    const workspaceId = event.workspaceId;
    const integrationId = event.entityId;
    const { provider, runId } = event.payload;
    if (!workspaceId || !integrationId) {
      await this.reconciliationRunService.failReconciliationRun(
        runId,
        'Reconciliation event was missing workspace or integration context.',
      );
      return;
    }

    const credentials = await this.integrationService.getCredentials(workspaceId, provider);
    if (!credentials) {
      await this.reconciliationRunService.failReconciliationRun(runId, 'No credentials stored for this provider.');
      return;
    }

    const adapter = this.providerRegistry.get(provider);
    let counts: ReconcileCounts = { checked: 0, found: 0, repaired: 0 };

    try {
      if (adapter.fetchCustomers) {
        counts = await this.reconcileCustomers(adapter, credentials, workspaceId, integrationId, provider, runId, counts);
      }
      if (adapter.fetchProducts) {
        counts = await this.reconcileProducts(adapter, credentials, workspaceId, integrationId, provider, runId, counts);
      }
      if (adapter.fetchOrders) {
        counts = await this.reconcileOrders(adapter, credentials, workspaceId, integrationId, provider, runId, counts);
      }
      if (adapter.fetchCollections) {
        counts = await this.reconcileCollections(adapter, credentials, workspaceId, integrationId, provider, runId, counts);
      }
      // Depends on both products and collections already being reconciled above.
      if (adapter.fetchCollects) {
        await this.reconcileCollects(adapter, credentials, workspaceId, integrationId, provider, runId, counts);
      }

      await this.reconciliationRunService.completeReconciliationRun(runId);
    } catch (error) {
      await this.reconciliationRunService.failReconciliationRun(
        runId,
        error instanceof Error ? error.message : 'Unknown reconciliation error.',
      );
    }
  }

  private async reconcileCustomers(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    runId: string,
    start: ReconcileCounts,
  ): Promise<ReconcileCounts> {
    let cursor: string | undefined;
    let { checked, found, repaired } = start;

    do {
      const page = await adapter.fetchCustomers!(credentials, cursor);
      const existing = await this.customerService.findExistingUpdatedAt(
        workspaceId,
        provider,
        page.customers.map((c) => c.externalId),
      );
      const discrepancies = page.customers.filter((c) => isDiscrepancy(existing.get(c.externalId), c.sourceUpdatedAt)).length;

      try {
        await this.customerService.upsertMany(workspaceId, integrationId, provider, page.customers);
        await this.identityResolutionService.resolveMany(workspaceId, provider, page.customers.map((c) => c.externalId));
        repaired += discrepancies;
      } catch {
        // Leave `found` counted but not repaired — mirrors ImportProcessorService's per-page failure tolerance.
      }

      checked += page.customers.length;
      found += discrepancies;
      cursor = page.nextCursor ?? undefined;
      await this.reconciliationRunService.recordProgress(runId, {
        recordsChecked: checked,
        discrepanciesFound: found,
        discrepanciesRepaired: repaired,
      });
    } while (cursor);

    return { checked, found, repaired };
  }

  private async reconcileProducts(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    runId: string,
    start: ReconcileCounts,
  ): Promise<ReconcileCounts> {
    let cursor: string | undefined;
    let { checked, found, repaired } = start;

    do {
      const page = await adapter.fetchProducts!(credentials, cursor);
      const existing = await this.productService.findExistingUpdatedAt(
        workspaceId,
        provider,
        page.products.map((p) => p.externalId),
      );
      const discrepancies = page.products.filter((p) => isDiscrepancy(existing.get(p.externalId), p.sourceUpdatedAt)).length;

      try {
        await this.productService.upsertMany(workspaceId, integrationId, provider, page.products);
        repaired += discrepancies;
      } catch {
        // Leave `found` counted but not repaired — mirrors ImportProcessorService's per-page failure tolerance.
      }

      checked += page.products.length;
      found += discrepancies;
      cursor = page.nextCursor ?? undefined;
      await this.reconciliationRunService.recordProgress(runId, {
        recordsChecked: checked,
        discrepanciesFound: found,
        discrepanciesRepaired: repaired,
      });
    } while (cursor);

    return { checked, found, repaired };
  }

  private async reconcileOrders(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    runId: string,
    start: ReconcileCounts,
  ): Promise<ReconcileCounts> {
    let cursor: string | undefined;
    let { checked, found, repaired } = start;

    do {
      const page = await adapter.fetchOrders!(credentials, cursor);
      const existing = await this.orderService.findExistingUpdatedAt(
        workspaceId,
        provider,
        page.orders.map((o) => o.externalId),
      );
      const discrepancies = page.orders.filter((o) => isDiscrepancy(existing.get(o.externalId), o.sourceUpdatedAt)).length;

      try {
        await this.orderService.upsertMany(workspaceId, integrationId, provider, page.orders);
        repaired += discrepancies;
      } catch {
        // Leave `found` counted but not repaired — mirrors ImportProcessorService's per-page failure tolerance.
      }

      checked += page.orders.length;
      found += discrepancies;
      cursor = page.nextCursor ?? undefined;
      await this.reconciliationRunService.recordProgress(runId, {
        recordsChecked: checked,
        discrepanciesFound: found,
        discrepanciesRepaired: repaired,
      });
    } while (cursor);

    return { checked, found, repaired };
  }

  private async reconcileCollections(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    runId: string,
    start: ReconcileCounts,
  ): Promise<ReconcileCounts> {
    let cursor: string | undefined;
    let { checked, found, repaired } = start;

    do {
      const page = await adapter.fetchCollections!(credentials, cursor);
      const existing = await this.collectionService.findExistingUpdatedAt(
        workspaceId,
        provider,
        page.collections.map((c) => c.externalId),
      );
      const discrepancies = page.collections.filter((c) => isDiscrepancy(existing.get(c.externalId), c.sourceUpdatedAt)).length;

      try {
        await this.collectionService.upsertMany(workspaceId, integrationId, provider, page.collections);
        repaired += discrepancies;
      } catch {
        // Leave `found` counted but not repaired — mirrors ImportProcessorService's per-page failure tolerance.
      }

      checked += page.collections.length;
      found += discrepancies;
      cursor = page.nextCursor ?? undefined;
      await this.reconciliationRunService.recordProgress(runId, {
        recordsChecked: checked,
        discrepanciesFound: found,
        discrepanciesRepaired: repaired,
      });
    } while (cursor);

    return { checked, found, repaired };
  }

  /**
   * Collect has no `sourceUpdatedAt` to compare (see CollectionService's
   * doc comment — a membership link either exists or doesn't), so this
   * can't distinguish missing-vs-already-correct the way the other
   * reconcile* methods do. `found` isn't incremented — everything checked
   * here is simply re-applied idempotently.
   */
  private async reconcileCollects(
    adapter: ProviderAdapter,
    credentials: Record<string, string>,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    runId: string,
    start: ReconcileCounts,
  ): Promise<ReconcileCounts> {
    let cursor: string | undefined;
    let { checked, repaired } = start;
    const { found } = start;

    do {
      const page = await adapter.fetchCollects!(credentials, cursor);
      try {
        repaired += await this.collectionService.upsertCollects(workspaceId, integrationId, provider, page.collects);
      } catch {
        // Leave this page's collects uncounted as repaired — mirrors ImportProcessorService's per-page failure tolerance.
      }

      checked += page.collects.length;
      cursor = page.nextCursor ?? undefined;
      await this.reconciliationRunService.recordProgress(runId, {
        recordsChecked: checked,
        discrepanciesFound: found,
        discrepanciesRepaired: repaired,
      });
    } while (cursor);

    return { checked, found, repaired };
  }
}

/** No existing row (`undefined`) is missing; a differing `sourceUpdatedAt` is changed. A null fetched timestamp can't be compared, so it's treated as unchanged rather than a false discrepancy. */
function isDiscrepancy(existing: Date | null | undefined, fetched: Date | null): boolean {
  if (existing === undefined) {
    return true;
  }
  if (!fetched) {
    return false;
  }
  return existing?.getTime() !== fetched.getTime();
}
