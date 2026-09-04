import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { commerceOrderLineItems } from '../../database/schema/commerce-order-line-items';
import { commerceFulfillments } from '../../database/schema/commerce-fulfillments';
import { commerceRefunds } from '../../database/schema/commerce-refunds';
import { commerceRefundLineItems } from '../../database/schema/commerce-refund-line-items';
import { commerceProducts } from '../../database/schema/commerce-products';
import { commerceProductVariants } from '../../database/schema/commerce-product-variants';
import { commerceCollections } from '../../database/schema/commerce-collections';
import { commerceCollectionProducts } from '../../database/schema/commerce-collection-products';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { canonicalCustomerDuplicates } from '../../database/schema/canonical-customer-duplicates';
import { conversations } from '../../database/schema/conversations';
import { conversationMessages } from '../../database/schema/conversation-messages';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { customerHealthStates } from '../../database/schema/customer-health-states';
import { customerHealthStateHistory } from '../../database/schema/customer-health-state-history';
import { automationRuns } from '../../database/schema/automation-runs';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { ConflictError, NotFoundError, ProviderError, UnauthenticatedError } from '../../common/errors/app-error';
import {
  decryptCredential,
  encryptCredential,
  InvalidEncryptionKeyError,
  parseEncryptionKey,
} from '../../common/crypto/credential-cipher';
import { createEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { ImportRunService } from './import-run.service';
import { ReconciliationRunService } from './reconciliation-run.service';
import { ProviderRegistry } from './provider-registry.service';
import type { ImportRequestedPayload } from './import-processor.service';
import type { ReconciliationRequestedPayload } from './reconciliation-processor.service';
import type { SyncRequestedPayload } from './sync-processor.service';
import type { IntegrationProvider } from './dto/connect-integration.schema';
import type { Env } from '../../config/env.schema';

/** Refresh a bit before actual expiry (shopify.dev's own offline-token example refreshes ~60s early) rather than racing a request against the exact cutoff. */
const CREDENTIAL_REFRESH_SKEW_MS = 60_000;

/**
 * How long a disconnected integration's customer data is retained before
 * it becomes eligible for purge (Shopify Protected Customer Data —
 * "retention periods that make sure personal data isn't kept longer than
 * needed"). 90 days: long enough that a merchant who disconnects and
 * reconnects within a normal cycle doesn't lose their import history and
 * force a full re-import; short enough that data isn't kept indefinitely
 * once BRAYN no longer has an active relationship with the store. A
 * single fixed constant, not a configurable policy — see
 * `purgeCustomerData`'s doc comment for why.
 */
const CUSTOMER_DATA_RETENTION_DAYS = 90;

/**
 * Columns safe to return from the API. Excludes `credentials` — the
 * encrypted payload must never leave the service layer (doc 18: provider
 * credentials are never exposed to users or AI).
 */
const integrationPublicColumns = {
  id: integrations.id,
  workspaceId: integrations.workspaceId,
  provider: integrations.provider,
  status: integrations.status,
  lastSyncedAt: integrations.lastSyncedAt,
  lastSyncError: integrations.lastSyncError,
  createdAt: integrations.createdAt,
  updatedAt: integrations.updatedAt,
};

@Injectable()
export class IntegrationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Env, true>,
    private readonly providerRegistry: ProviderRegistry,
    private readonly importRunService: ImportRunService,
    private readonly reconciliationRunService: ReconciliationRunService,
    private readonly eventBus: EventBus,
  ) {}

  async listByWorkspace(workspaceId: string) {
    return this.database.client
      .select(integrationPublicColumns)
      .from(integrations)
      .where(eq(integrations.workspaceId, workspaceId));
  }

  private async findByProvider(workspaceId: string, provider: IntegrationProvider) {
    const [integration] = await this.database.client
      .select()
      .from(integrations)
      .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider)))
      .limit(1);

    return integration ?? null;
  }

  /** Connects a provider, or reconnects one this workspace previously disconnected. */
  async connect(workspaceId: string, provider: IntegrationProvider) {
    const existing = await this.findByProvider(workspaceId, provider);

    if (existing && existing.status !== 'disconnected') {
      throw new ConflictError('This provider is already connected.');
    }

    if (existing) {
      const [reconnected] = await this.database.client
        .update(integrations)
        .set({ status: 'connected', lastSyncError: null })
        .where(eq(integrations.id, existing.id))
        .returning(integrationPublicColumns);

      return reconnected;
    }

    const [created] = await this.database.client
      .insert(integrations)
      .values({ workspaceId, provider })
      .returning(integrationPublicColumns);

    return created;
  }

  /**
   * Clears the stored (encrypted) provider credential in the same update as
   * the status flip — not a separate step — so a disconnect can never leave
   * the old credential behind (doc18 Secrets/Security Operations: credential
   * revocation). Reconnecting goes through connect()/setCredentials() again,
   * which always writes a fresh value, so this never blocks reconnection.
   */
  async disconnect(workspaceId: string, provider: IntegrationProvider) {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }

    const [updated] = await this.database.client
      .update(integrations)
      .set({ status: 'disconnected', lastSyncError: null, credentials: null })
      .where(eq(integrations.id, existing.id))
      .returning(integrationPublicColumns);

    return updated;
  }

  /**
   * Purges a disconnected integration's customer data once
   * `CUSTOMER_DATA_RETENTION_DAYS` has elapsed since it was disconnected
   * (doc18 Security/PII — data minimization; Shopify Protected Customer
   * Data). Manual/on-demand only — no scheduler exists or is introduced
   * here (doc29 — no speculative queue/worker infrastructure); this is
   * the same "on-demand for now" posture already used for reconciliation.
   *
   * `IntegrationService` is the lifecycle owner (it already owns
   * connect/disconnect and `updatedAt` is the retention anchor), but the
   * actual delete touches Commerce/Identity Resolution/Customer
   * Intelligence Engines/Conversation/Automation tables directly within
   * one transaction — the same "read another domain's schema directly for
   * a tightly-scoped cross-cutting operation" precedent already used by
   * `CustomerIntelligenceService` (which reads `commerceCustomers`/
   * `commerceOrders` directly rather than through a Commerce service
   * class). Adding a "delete customer data" method to five separate
   * domain services for one narrow operation would be more machinery, not
   * less (doc18 — keep this simple).
   *
   * Deletion is strictly scoped to rows carrying this integration's own
   * `integrationId` (commerce data) or, for canonical customers, only
   * those left with zero remaining `commerce_customers` rows from *any*
   * integration after this one's are removed — a canonical customer with
   * data from another still-connected integration is never touched. Every
   * delete is a plain `WHERE`-scoped delete, so a repeat run (nothing left
   * to match) is a no-op, not an error — idempotent by construction, no
   * special-casing needed.
   */
  async purgeCustomerData(workspaceId: string, provider: IntegrationProvider) {
    const integration = await this.findByProvider(workspaceId, provider);
    if (!integration) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }
    if (integration.status !== 'disconnected') {
      throw new ConflictError('Only a disconnected integration can have its customer data purged.');
    }

    const retentionMs = CUSTOMER_DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const eligibleAt = new Date(integration.updatedAt.getTime() + retentionMs);
    if (Date.now() < eligibleAt.getTime()) {
      throw new ConflictError(
        `This integration's ${CUSTOMER_DATA_RETENTION_DAYS}-day retention period has not elapsed yet (eligible ${eligibleAt.toISOString()}).`,
      );
    }

    return this.database.transaction(async (tx) => {
      const result = await this.purgeIntegrationCommerceData(tx, workspaceId, integration.id);
      return { integrationId: integration.id, ...result };
    });
  }

  /**
   * Finds the integration a Shopify app-level compliance webhook
   * (`customers/data_request`/`customers/redact`/`shop/redact`) belongs
   * to. Those webhooks arrive at one fixed URL for every shop the app is
   * installed on — no workspace id to key off, only `shop_domain` in the
   * payload — so this resolves the other direction `findByProvider` does.
   * Ordered by most-recently-updated: a shop can theoretically appear on
   * more than one (historical, disconnected) integration row across
   * workspaces if it was moved; the most recent one is the live one.
   */
  async findByShopDomain(shopDomain: string) {
    const [integration] = await this.database.client
      .select()
      .from(integrations)
      .where(eq(integrations.shopDomain, shopDomain))
      .orderBy(desc(integrations.updatedAt))
      .limit(1);

    return integration ?? null;
  }

  /**
   * Shopify `customers/redact` — resolves the commerce customer by the
   * provider's own external id (Shopify `customer.id`) within one
   * integration, and erases just that customer's data. Narrower than
   * `purgeCustomerData` (whole-integration) and, unlike it, never gated
   * on `CUSTOMER_DATA_RETENTION_DAYS` or on the integration being
   * `disconnected`: a mandatory compliance erasure must be honored
   * immediately regardless of BRAYN's own voluntary-disconnect retention
   * policy. Resolution and deletion share one transaction so there is no
   * gap between "found" and "deleted". Shares the exact
   * canonical-customer orphan check `purgeIntegrationCommerceData`'s loop
   * uses, so a canonical customer still referenced by another
   * integration's `commerce_customers` row is preserved here the same
   * way it already is there.
   */
  async purgeCommerceCustomer(
    workspaceId: string,
    integrationId: string,
    externalId: string,
  ): Promise<{ found: boolean; canonicalCustomerRemoved: boolean }> {
    return this.database.transaction(async (tx) => {
      const [customerRow] = await tx
        .select({ id: commerceCustomers.id, canonicalCustomerId: commerceCustomers.canonicalCustomerId })
        .from(commerceCustomers)
        .where(
          and(
            eq(commerceCustomers.workspaceId, workspaceId),
            eq(commerceCustomers.integrationId, integrationId),
            eq(commerceCustomers.externalId, externalId),
          ),
        )
        .limit(1);
      if (!customerRow) {
        return { found: false, canonicalCustomerRemoved: false };
      }

      const orderRows = await tx
        .select({ id: commerceOrders.id })
        .from(commerceOrders)
        .where(and(eq(commerceOrders.workspaceId, workspaceId), eq(commerceOrders.customerId, customerRow.id)));
      const orderIds = orderRows.map((row) => row.id);

      if (orderIds.length > 0) {
        const refundRows = await tx
          .select({ id: commerceRefunds.id })
          .from(commerceRefunds)
          .where(and(eq(commerceRefunds.workspaceId, workspaceId), inArray(commerceRefunds.orderId, orderIds)));
        const refundIds = refundRows.map((row) => row.id);

        // Same relative order as purgeIntegrationCommerceData's order-scoped block, just scoped by this customer's order ids instead of the whole integration.
        await tx.delete(commerceOrderLineItems).where(and(eq(commerceOrderLineItems.workspaceId, workspaceId), inArray(commerceOrderLineItems.orderId, orderIds)));
        if (refundIds.length > 0) {
          await tx.delete(commerceRefundLineItems).where(and(eq(commerceRefundLineItems.workspaceId, workspaceId), inArray(commerceRefundLineItems.refundId, refundIds)));
        }
        await tx.delete(commerceFulfillments).where(and(eq(commerceFulfillments.workspaceId, workspaceId), inArray(commerceFulfillments.orderId, orderIds)));
        await tx.delete(commerceRefunds).where(and(eq(commerceRefunds.workspaceId, workspaceId), inArray(commerceRefunds.orderId, orderIds)));
        await tx.delete(commerceOrders).where(and(eq(commerceOrders.workspaceId, workspaceId), inArray(commerceOrders.id, orderIds)));
      }

      await tx.delete(commerceCustomers).where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.id, customerRow.id)));

      const canonicalCustomerRemoved = customerRow.canonicalCustomerId
        ? await this.purgeCanonicalCustomerIfOrphaned(tx, workspaceId, customerRow.canonicalCustomerId)
        : false;

      return { found: true, canonicalCustomerRemoved };
    });
  }

  /**
   * Shopify `shop/redact` — immediate, ungated erasure of everything this
   * integration owns, plus disconnecting it. Unlike `purgeCustomerData`,
   * never waits on `CUSTOMER_DATA_RETENTION_DAYS` or requires the
   * integration to already be `disconnected`: Shopify's mandatory
   * compliance webhook must be honored regardless of BRAYN's own
   * voluntary-disconnect retention policy (see doc30's note on this exact
   * tension). Also erases the integration's own catalog
   * (products/variants/collections) — the *shop's* data, not customer
   * PII, but still integration-owned data Shopify expects gone on
   * `shop/redact` — which `purgeCustomerData`/`customers/redact` never
   * touch, since neither of those implies the shop itself is gone.
   *
   * Deliberately leaves the `integrations` row itself in place —
   * disconnected, credential-less, `shopDomain` cleared — the same shape
   * a voluntary `disconnect()` leaves behind, rather than hard-deleting
   * the row, which would additionally require clearing its (non-PII)
   * import/reconciliation run history purely to satisfy their own FK
   * references — a bigger blast radius than this compliance requirement
   * calls for. A no-op (returns `found: false`) if the id doesn't exist —
   * a repeat delivery for an already-erased shop is safe.
   */
  async eraseIntegrationForShopRedact(integrationId: string): Promise<{ found: boolean }> {
    return this.database.transaction(async (tx) => {
      const [integration] = await tx.select().from(integrations).where(eq(integrations.id, integrationId)).limit(1);
      if (!integration) {
        return { found: false };
      }

      await this.purgeIntegrationCommerceData(tx, integration.workspaceId, integration.id);

      // Catalog data — integration-scoped, not customer-scoped, so out of purgeIntegrationCommerceData's remit.
      await tx
        .delete(commerceCollectionProducts)
        .where(and(eq(commerceCollectionProducts.workspaceId, integration.workspaceId), eq(commerceCollectionProducts.integrationId, integration.id)));
      await tx
        .delete(commerceProductVariants)
        .where(and(eq(commerceProductVariants.workspaceId, integration.workspaceId), eq(commerceProductVariants.integrationId, integration.id)));
      await tx
        .delete(commerceCollections)
        .where(and(eq(commerceCollections.workspaceId, integration.workspaceId), eq(commerceCollections.integrationId, integration.id)));
      await tx.delete(commerceProducts).where(and(eq(commerceProducts.workspaceId, integration.workspaceId), eq(commerceProducts.integrationId, integration.id)));

      await tx
        .update(integrations)
        .set({ status: 'disconnected', lastSyncError: null, credentials: null, shopDomain: null })
        .where(eq(integrations.id, integration.id));

      return { found: true };
    });
  }

  /**
   * The shared body of `purgeCustomerData()` (Part 1) — extracted so
   * `shop/redact` (`eraseIntegrationForShopRedact`) can run the exact same
   * cascade without `purgeCustomerData`'s disconnected/retention gate.
   * Whole-integration scoped: every commerce_customers row this
   * integration owns, and the same canonical-customer orphan check
   * `purgeCommerceCustomer` also uses for its single-customer case.
   */
  private async purgeIntegrationCommerceData(
    tx: NodePgDatabase,
    workspaceId: string,
    integrationId: string,
  ): Promise<{ commerceCustomersRemoved: number; canonicalCustomersRemoved: number }> {
    // Capture which canonical customers this integration's commerce_customers
    // rows point to *before* deleting them — needed to check afterward whether
    // each one is now orphaned (doc09 — a canonical customer may span providers).
    const linked = await tx
      .select({ canonicalCustomerId: commerceCustomers.canonicalCustomerId })
      .from(commerceCustomers)
      .where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.integrationId, integrationId), isNotNull(commerceCustomers.canonicalCustomerId)));
    const candidateCanonicalIds = [...new Set(linked.map((row) => row.canonicalCustomerId as string))];

    // Raw webhook deliveries for this integration can carry the same
    // customer PII as the commerce tables below (a customer/order
    // webhook's payload is the provider's raw record) — nothing else
    // references this table, so it's safe to remove outright rather than
    // leaving a second, ungoverned copy behind after the purge (DLP).
    await tx.delete(integrationWebhookEvents).where(and(eq(integrationWebhookEvents.workspaceId, workspaceId), eq(integrationWebhookEvents.integrationId, integrationId)));

    // Order-scoped tables first (FK-safe order), all directly integration-scoped.
    await tx.delete(commerceOrderLineItems).where(and(eq(commerceOrderLineItems.workspaceId, workspaceId), eq(commerceOrderLineItems.integrationId, integrationId)));
    await tx.delete(commerceRefundLineItems).where(and(eq(commerceRefundLineItems.workspaceId, workspaceId), eq(commerceRefundLineItems.integrationId, integrationId)));
    await tx.delete(commerceFulfillments).where(and(eq(commerceFulfillments.workspaceId, workspaceId), eq(commerceFulfillments.integrationId, integrationId)));
    await tx.delete(commerceRefunds).where(and(eq(commerceRefunds.workspaceId, workspaceId), eq(commerceRefunds.integrationId, integrationId)));
    await tx.delete(commerceOrders).where(and(eq(commerceOrders.workspaceId, workspaceId), eq(commerceOrders.integrationId, integrationId)));

    const removedCommerceCustomers = await tx
      .delete(commerceCustomers)
      .where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.integrationId, integrationId)))
      .returning({ id: commerceCustomers.id });

    // A canonical customer is only removed once nothing else in the workspace
    // still references it — never on the strength of this integration alone.
    let canonicalCustomersRemoved = 0;
    for (const canonicalCustomerId of candidateCanonicalIds) {
      const removed = await this.purgeCanonicalCustomerIfOrphaned(tx, workspaceId, canonicalCustomerId);
      if (removed) {
        canonicalCustomersRemoved++;
      }
    }

    return { commerceCustomersRemoved: removedCommerceCustomers.length, canonicalCustomersRemoved };
  }

  /**
   * Deletes a canonical customer and everything keyed off it — but only
   * if no `commerce_customers` row anywhere in the workspace still points
   * to it (a canonical customer may span providers/integrations — doc09).
   * Shared by `purgeIntegrationCommerceData`'s per-integration loop and
   * `purgeCommerceCustomer`'s single-customer case, so both erasure paths
   * preserve shared canonical data identically. Returns whether it was
   * actually removed.
   */
  private async purgeCanonicalCustomerIfOrphaned(tx: NodePgDatabase, workspaceId: string, canonicalCustomerId: string): Promise<boolean> {
    const [remaining] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(commerceCustomers)
      .where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.canonicalCustomerId, canonicalCustomerId)));
    if (Number(remaining?.count ?? 0) > 0) {
      return false;
    }

    await tx.delete(recommendations).where(and(eq(recommendations.workspaceId, workspaceId), eq(recommendations.canonicalCustomerId, canonicalCustomerId)));
    await tx.delete(revenueOpportunities).where(and(eq(revenueOpportunities.workspaceId, workspaceId), eq(revenueOpportunities.canonicalCustomerId, canonicalCustomerId)));
    await tx.delete(customerHealthStateHistory).where(and(eq(customerHealthStateHistory.workspaceId, workspaceId), eq(customerHealthStateHistory.canonicalCustomerId, canonicalCustomerId)));
    await tx.delete(customerHealthStates).where(and(eq(customerHealthStates.workspaceId, workspaceId), eq(customerHealthStates.canonicalCustomerId, canonicalCustomerId)));
    await tx.delete(automationRuns).where(and(eq(automationRuns.workspaceId, workspaceId), eq(automationRuns.canonicalCustomerId, canonicalCustomerId)));
    await tx
      .delete(canonicalCustomerDuplicates)
      .where(
        and(
          eq(canonicalCustomerDuplicates.workspaceId, workspaceId),
          or(eq(canonicalCustomerDuplicates.canonicalCustomerAId, canonicalCustomerId), eq(canonicalCustomerDuplicates.canonicalCustomerBId, canonicalCustomerId)),
        ),
      );

    const conversationRows = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.canonicalCustomerId, canonicalCustomerId)));
    const conversationIds = conversationRows.map((row) => row.id);
    if (conversationIds.length > 0) {
      await tx.delete(conversationMessages).where(and(eq(conversationMessages.workspaceId, workspaceId), inArray(conversationMessages.conversationId, conversationIds)));
    }
    await tx.delete(conversations).where(and(eq(conversations.workspaceId, workspaceId), eq(conversations.canonicalCustomerId, canonicalCustomerId)));

    await tx.delete(canonicalCustomers).where(and(eq(canonicalCustomers.workspaceId, workspaceId), eq(canonicalCustomers.id, canonicalCustomerId)));
    return true;
  }

  /**
   * Marks a sync run as started. Requires an existing connection that
   * isn't already mid-sync (doc 07 — idempotency: don't let two syncs run
   * concurrently for the same integration); allowed from `connected` or a
   * prior `error` (retry).
   */
  async startSync(workspaceId: string, provider: IntegrationProvider) {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }
    if (existing.status === 'disconnected') {
      throw new ConflictError('Cannot sync a disconnected integration.');
    }
    if (existing.status === 'syncing') {
      throw new ConflictError('A sync is already in progress for this provider.');
    }

    const [updated] = await this.database.client
      .update(integrations)
      .set({ status: 'syncing', lastSyncError: null })
      .where(eq(integrations.id, existing.id))
      .returning(integrationPublicColumns);

    return updated;
  }

  /** Marks an in-progress sync as succeeded. Requires startSync() to have been called first. */
  async completeSync(workspaceId: string, provider: IntegrationProvider) {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }
    if (existing.status !== 'syncing') {
      throw new ConflictError('No sync is in progress for this provider.');
    }

    const [updated] = await this.database.client
      .update(integrations)
      .set({ status: 'connected', lastSyncedAt: new Date(), lastSyncError: null })
      .where(eq(integrations.id, existing.id))
      .returning(integrationPublicColumns);

    return updated;
  }

  /** Marks an in-progress sync as failed. Requires startSync() to have been called first. */
  async failSync(workspaceId: string, provider: IntegrationProvider, error: string) {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }
    if (existing.status !== 'syncing') {
      throw new ConflictError('No sync is in progress for this provider.');
    }

    const [updated] = await this.database.client
      .update(integrations)
      .set({ status: 'error', lastSyncError: error })
      .where(eq(integrations.id, existing.id))
      .returning(integrationPublicColumns);

    return updated;
  }

  /**
   * Starts a background incremental sync (doc 06/20 — Incremental
   * Synchronization: the catch-up mechanism after webhooks, before
   * reconciliation), same async-job shape as startInitialImport/
   * startReconciliation. `startSync()` does the state transition and
   * returns the row still carrying the *previous* `lastSyncedAt` — exactly
   * the cursor SyncProcessorService needs to ask the provider "what
   * changed since then." Falls back to `createdAt` (connect time) if this
   * integration has never completed a sync.
   */
  async startIncrementalSync(workspaceId: string, provider: IntegrationProvider) {
    const adapter = this.providerRegistry.get(provider);
    if (!adapter.fetchCustomers) {
      throw new ProviderError(`Provider "${provider}" does not support incremental synchronization.`);
    }

    const updated = await this.startSync(workspaceId, provider);
    const updatedAtMin = updated.lastSyncedAt ?? updated.createdAt;

    this.eventBus.emit(
      createEvent<SyncRequestedPayload>({
        type: 'integration.sync.requested',
        workspaceId,
        entityId: updated.id,
        payload: { provider, updatedAtMin: updatedAtMin.toISOString() },
      }),
    );

    return updated;
  }

  /**
   * Verifies `credentials` against the provider (via its registered
   * ProviderAdapter) before storing them — never persist a credential the
   * provider itself rejects. This is what the controller's credentials
   * endpoint calls; setCredentials()/getCredentials() stay available for
   * internal use (e.g. a future OAuth callback storing a token it already
   * verified as part of the exchange itself).
   */
  async connectCredentials(
    workspaceId: string,
    provider: IntegrationProvider,
    credentials: Record<string, string>,
  ): Promise<void> {
    const adapter = this.providerRegistry.get(provider);
    const verified = await adapter.verifyConnection(credentials);
    if (!verified) {
      throw new UnauthenticatedError('Could not verify these credentials with the provider.');
    }

    await this.setCredentials(workspaceId, provider, credentials);
  }

  /**
   * Starts a background initial import (doc 20 — Initial Import; doc 23
   * Async Operations — "return an operation/job reference instead of
   * blocking the request"). Creates the run row synchronously (so the
   * caller gets an id to poll) then hands the actual paginated fetch to
   * ImportProcessorService via an event, off the request.
   */
  async startInitialImport(workspaceId: string, provider: IntegrationProvider) {
    const adapter = this.providerRegistry.get(provider);
    if (!adapter.fetchCustomers) {
      throw new ProviderError(`Provider "${provider}" does not support customer import.`);
    }

    const run = await this.importRunService.startImportRun(workspaceId, provider);

    this.eventBus.emit(
      createEvent<ImportRequestedPayload>({
        type: 'integration.import.requested',
        workspaceId,
        entityId: run.integrationId,
        payload: { provider, runId: run.id },
      }),
    );

    return run;
  }

  /**
   * Starts a manual reconciliation pass (doc 06/19/20 — Reconciliation:
   * detect/repair drift against provider state), same async-job shape as
   * startInitialImport. `manual` is the only trigger a caller can invoke
   * this way — the other triggers doc 06 lists (scheduled, sync_completion,
   * detected_inconsistency) need a scheduler/hook that doesn't exist yet
   * (doc 29 §32 defers queue/worker technology).
   */
  async startReconciliation(workspaceId: string, provider: IntegrationProvider) {
    const adapter = this.providerRegistry.get(provider);
    if (!adapter.fetchCustomers) {
      throw new ProviderError(`Provider "${provider}" does not support reconciliation.`);
    }

    const run = await this.reconciliationRunService.startReconciliationRun(workspaceId, provider, 'manual');

    this.eventBus.emit(
      createEvent<ReconciliationRequestedPayload>({
        type: 'integration.reconciliation.requested',
        workspaceId,
        entityId: run.integrationId,
        payload: { provider, runId: run.id },
      }),
    );

    return run;
  }

  /**
   * Encrypts and stores a provider's credential payload. Internal-only —
   * not exposed through the controller; provider-specific connect flows
   * (Phase 4) call this after completing their own auth handshake.
   */
  async setCredentials(
    workspaceId: string,
    provider: IntegrationProvider,
    credentials: Record<string, string>,
  ): Promise<void> {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }

    const key = this.resolveEncryptionKey();
    const encrypted = encryptCredential(JSON.stringify(credentials), key);

    // shopDomain is plaintext (unlike the rest of `credentials`) precisely so
    // a Shopify app-level compliance webhook can resolve this row by shop —
    // see findByShopDomain(). Only ever set from what the credential payload
    // itself carries, never guessed.
    await this.database.client
      .update(integrations)
      .set({ credentials: encrypted, ...(credentials.shopDomain ? { shopDomain: credentials.shopDomain } : {}) })
      .where(eq(integrations.id, existing.id));
  }

  /**
   * Decrypts a provider's stored credential payload. Internal-only, same
   * as setCredentials(). Transparently re-mints it first if it's
   * expiring — see refreshIfExpiring's doc comment.
   */
  async getCredentials(workspaceId: string, provider: IntegrationProvider): Promise<Record<string, string> | null> {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing?.credentials) {
      return null;
    }

    const key = this.resolveEncryptionKey();
    const credentials = JSON.parse(decryptCredential(existing.credentials, key)) as Record<string, string>;

    const refreshed = await this.refreshIfExpiring(workspaceId, provider, credentials);
    return refreshed ?? credentials;
  }

  /**
   * Provider-agnostic refresh-on-read: keys off `credentials.expiresAt`
   * plus the adapter's own optional `refreshCredentials` (doc20 — some
   * grant types, e.g. Shopify's client-credentials grant, issue
   * short-lived tokens with no refresh_token). A credential shape that
   * never expires (WooCommerce, Shopify's authorization-code token as
   * BRAYN requests it today) has no `expiresAt` and never enters this
   * branch. Called once per `getCredentials()`, matching every consumer's
   * own pattern (import/sync/reconciliation/webhook processors each fetch
   * credentials once at the start of a run, not per-request within it).
   */
  private async refreshIfExpiring(
    workspaceId: string,
    provider: IntegrationProvider,
    credentials: Record<string, string>,
  ): Promise<Record<string, string> | null> {
    const expiresAt = credentials.expiresAt;
    if (!expiresAt || new Date(expiresAt).getTime() > Date.now() + CREDENTIAL_REFRESH_SKEW_MS) {
      return null;
    }

    const adapter = this.providerRegistry.get(provider);
    const refreshed = await adapter.refreshCredentials?.(credentials);
    if (!refreshed) {
      return null;
    }

    await this.setCredentials(workspaceId, provider, refreshed);
    return refreshed;
  }

  private resolveEncryptionKey() {
    try {
      return parseEncryptionKey(this.config.get('BRAYN_CREDENTIAL_ENCRYPTION_KEY', { infer: true }));
    } catch (error) {
      if (error instanceof InvalidEncryptionKeyError) {
        // Fail closed rather than silently storing/returning credentials
        // unprotected — see "18. BRAYN Security, Observability & Reliability".
        throw new ProviderError('Credential encryption is not configured.');
      }
      throw error;
    }
  }
}
