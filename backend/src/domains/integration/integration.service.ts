import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { integrationImportRuns } from '../../database/schema/integration-import-runs';
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
import { identityMergeHistory } from '../../database/schema/identity-merge-history';
import { conversations } from '../../database/schema/conversations';
import { conversationMessages } from '../../database/schema/conversation-messages';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { internalNotifications } from '../../database/schema/internal-notifications';
import { customerHealthStates } from '../../database/schema/customer-health-states';
import { customerHealthStateHistory } from '../../database/schema/customer-health-state-history';
import { automationRuns } from '../../database/schema/automation-runs';
import { customerMemoryEntries } from '../../database/schema/customer-memory-entries';
import { customerMemoryEntryHistory } from '../../database/schema/customer-memory-entry-history';
import { customerPreferenceHistory, customerPreferences } from '../../database/schema/customer-preferences';
import { customerSummaries } from '../../database/schema/customer-summaries';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { checkoutSessions } from '../../database/schema/checkout-sessions';
import { websiteVisitors } from '../../database/schema/website-visitors';
import { websiteSessions } from '../../database/schema/website-sessions';
import { websiteEvents } from '../../database/schema/website-events';
import { aiActionRequests } from '../../database/schema/ai-action-requests';
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

/** Generic on purpose: never says which workspace holds the store (doc 18: no cross-tenant disclosure). */
export const STORE_OWNED_ELSEWHERE_MESSAGE =
  'This Shopify store is already connected to another BRAYN workspace. Disconnect it there first, or contact support to move it.';

const LIVE_SHOP_INDEXES = ['integrations_shopify_live_shop_unique', 'integrations_shopify_live_shop_id_unique'];

function isLiveShopConflict(error: unknown): boolean {
  const pg = error as { code?: string; constraint?: string };
  return pg?.code === '23505' && LIVE_SHOP_INDEXES.includes(pg.constraint ?? '');
}

type ShopifyIdentityRow = { id: string; workspaceId: string; status: string; shopDomain: string | null; shopifyShopId: string | null };

/**
 * Store identity rule: the numeric shop id decides when both sides have one; the domain only decides for a row whose id
 * is unknown (legacy, not yet backfilled) or when the caller has no id. A row whose domain matches but whose id
 * differs is a DIFFERENT store (e.g. a reassigned domain) — never treated as the same one.
 */
function classifyShopRow(row: ShopifyIdentityRow, shopDomain: string, shopId: string | undefined): 'match' | 'conflict' | 'none' {
  if (shopId && row.shopifyShopId === shopId) return 'match';
  if (row.shopDomain?.toLowerCase() !== shopDomain.toLowerCase()) return 'none';
  if (!shopId || !row.shopifyShopId) return 'match';
  return 'conflict';
}

function rethrowLiveShopConflict(error: unknown): never {
  throw isLiveShopConflict(error) ? new ConflictError(STORE_OWNED_ELSEWHERE_MESSAGE) : error;
}

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

  /**
   * Called by a store-bound connect flow (Shopify) before it (re)connects `provider` to `shopDomain`. The connection row
   * is reused across reconnects, so without this a previous connection's state would leak into the new one:
   * - a different store than the one this row last held is refused (`different_store`) while that store's commerce data
   *   is still here — two stores' customers and orders must never be mixed under one connection;
   * - reconnecting after a disconnect, or to a different store with no data left, clears the previous connection's
   *   import-run bookkeeping, so "first import" status (onboarding) reflects only the new connection. That reset runs
   *   inside connectStore(), only once the connection is actually accepted: a refused connect clears nothing.
   * Re-authorizing the same live store changes nothing.
   *
   * Store ownership (doc 22): a store that another workspace holds (live, or disconnected while that workspace still
   * keeps its data) is refused (`owned_elsewhere`) without revealing which workspace. Moving a store between
   * workspaces is an explicit, authorized procedure, never a side effect of an OAuth. This read is the friendly path;
   * the `integrations_shopify_live_shop_unique` index is what makes two concurrent connects of one store impossible
   * (see connectStore()).
   */
  async prepareStoreConnection(
    workspaceId: string,
    provider: IntegrationProvider,
    shopDomain: string,
    shopId?: string,
  ): Promise<'ok' | 'different_store' | 'owned_elsewhere'> {
    if (provider === 'shopify' && (await this.isStoreHeldElsewhere(workspaceId, shopDomain, shopId))) {
      return 'owned_elsewhere';
    }
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing) {
      return 'ok';
    }
    const sameStore = !existing.shopDomain || existing.shopDomain.toLowerCase() === shopDomain.toLowerCase();
    if (!sameStore && (await this.holdsCommerceData(workspaceId, existing.id))) {
      return 'different_store';
    }
    return 'ok';
  }

  /** Another workspace's Shopify row for this store is live, or disconnected but still holding the store's data. */
  private async isStoreHeldElsewhere(workspaceId: string, shopDomain: string, shopId?: string): Promise<boolean> {
    const others = (await this.selectShopifyIdentityRows(shopDomain, shopId)).filter(
      (row) => row.workspaceId !== workspaceId && classifyShopRow(row, shopDomain, shopId) === 'match',
    );
    for (const other of others) {
      if (other.status !== 'disconnected' || (await this.holdsCommerceData(other.workspaceId, other.id))) {
        return true;
      }
    }
    return false;
  }

  /** Every Shopify row matching the store by domain or by id (any status, oldest first); classify with classifyShopRow. */
  private async selectShopifyIdentityRows(shopDomain: string, shopId?: string): Promise<ShopifyIdentityRow[]> {
    const byDomain = sql`lower(${integrations.shopDomain}) = ${shopDomain.toLowerCase()}`;
    return this.database.client
      .select({
        id: integrations.id,
        workspaceId: integrations.workspaceId,
        status: integrations.status,
        shopDomain: integrations.shopDomain,
        shopifyShopId: integrations.shopifyShopId,
      })
      .from(integrations)
      .where(and(eq(integrations.provider, 'shopify'), shopId ? or(byDomain, eq(integrations.shopifyShopId, shopId)) : byDomain))
      .orderBy(integrations.createdAt, integrations.id);
  }

  private async holdsCommerceData(workspaceId: string, integrationId: string): Promise<boolean> {
    const [customer] = await this.database.client
      .select({ id: commerceCustomers.id })
      .from(commerceCustomers)
      .where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.integrationId, integrationId)))
      .limit(1);
    if (customer) {
      return true;
    }
    const [order] = await this.database.client
      .select({ id: commerceOrders.id })
      .from(commerceOrders)
      .where(and(eq(commerceOrders.workspaceId, workspaceId), eq(commerceOrders.integrationId, integrationId)))
      .limit(1);
    return Boolean(order);
  }

  /**
   * Store-bound (Shopify OAuth) connect: creates or reconnects the row and stores the credentials in ONE statement, so
   * the store-ownership index either accepts the whole connection or rejects it with nothing changed: no
   * half-connected row without credentials, no reconnected row to revert. `owned_elsewhere` = another workspace holds
   * this store live (e.g. a concurrent OAuth that won the race). An already-live row keeps its status (re-authorization).
   */
  async connectStore(
    workspaceId: string,
    provider: IntegrationProvider,
    credentials: Record<string, string>,
    shopId?: string,
  ): Promise<'ok' | 'owned_elsewhere'> {
    const encrypted = encryptCredential(JSON.stringify(credentials), this.resolveEncryptionKey());
    const shopDomain = credentials.shopDomain ? credentials.shopDomain.toLowerCase() : null;
    const reconnecting = sql`${integrations.status} = 'disconnected'`;
    try {
      await this.database.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: integrations.id, status: integrations.status, shopDomain: integrations.shopDomain })
          .from(integrations)
          .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider)))
          .for('update');
        await tx
          .insert(integrations)
          .values({ workspaceId, provider, credentials: encrypted, shopDomain, shopifyShopId: shopId ?? null })
          .onConflictDoUpdate({
            target: [integrations.workspaceId, integrations.provider],
            set: {
              status: sql`case when ${reconnecting} then 'connected' else ${integrations.status} end`,
              lastSyncError: sql`case when ${reconnecting} then null else ${integrations.lastSyncError} end`,
              credentials: encrypted,
              ...(shopDomain ? { shopDomain } : {}),
              ...(shopId ? { shopifyShopId: shopId } : {}),
              updatedAt: new Date(),
            },
          });
        // A reconnect, or a switch to another store (prepareStoreConnection already refused one with data left), starts
        // onboarding's "first import" afresh. Same transaction: a refused connect rolls this back too.
        const otherStore = Boolean(existing?.shopDomain && shopDomain && existing.shopDomain.toLowerCase() !== shopDomain);
        if (existing && (existing.status === 'disconnected' || otherStore)) {
          await tx.delete(integrationImportRuns).where(eq(integrationImportRuns.integrationId, existing.id));
        }
      });
    } catch (error) {
      if (isLiveShopConflict(error)) {
        return 'owned_elsewhere';
      }
      throw error;
    }
    return 'ok';
  }

  /** Connects a provider, or reconnects one this workspace previously disconnected. */
  async connect(workspaceId: string, provider: IntegrationProvider) {
    const existing = await this.findByProvider(workspaceId, provider);

    if (existing && existing.status !== 'disconnected') {
      throw new ConflictError('This provider is already connected.');
    }

    if (existing) {
      // A generic reconnect re-claims the store this row last held: refused while another workspace holds it (live, or
      // disconnected with its data), so a former holder can't make a credential-less row live and lock the owner out.
      if (provider === 'shopify' && existing.shopDomain && (await this.isStoreHeldElsewhere(workspaceId, existing.shopDomain))) {
        throw new ConflictError(STORE_OWNED_ELSEWHERE_MESSAGE);
      }
      try {
        const [reconnected] = await this.database.client
          .update(integrations)
          .set({ status: 'connected', lastSyncError: null })
          .where(eq(integrations.id, existing.id))
          .returning(integrationPublicColumns);

        return reconnected;
      } catch (error) {
        rethrowLiveShopConflict(error);
      }
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
  /**
   * Surfaces (or clears) a connection-setup failure that leaves the
   * integration connected but not fully usable — e.g. its provider webhook
   * subscriptions couldn't be registered — through the same `status`/
   * `lastSyncError` fields the integrations UI and health already show,
   * rather than reporting a healthy connection. Clearing only resets an
   * `error` status; it never overrides `syncing`/`disconnected`.
   */
  async setSetupError(workspaceId: string, provider: IntegrationProvider, error: string | null): Promise<void> {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }

    if (error) {
      await this.database.client.update(integrations).set({ status: 'error', lastSyncError: error }).where(eq(integrations.id, existing.id));
    } else if (existing.status === 'error') {
      await this.database.client.update(integrations).set({ status: 'connected', lastSyncError: null }).where(eq(integrations.id, existing.id));
    }
  }

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
   * Returns EVERY Shopify row for the store, any status, oldest first: at most one is live (store-ownership index),
   * but disconnected rows in other workspaces can still hold that store's retained data, and a compliance request
   * must reach all of it. Never "the most recently updated one": that picks an owner by accident.
   */
  async resolveShopHolders(
    shopDomain: string,
    shopId?: string,
  ): Promise<{ holders: ShopifyIdentityRow[]; conflicts: ShopifyIdentityRow[] }> {
    const rows = await this.selectShopifyIdentityRows(shopDomain, shopId);
    return {
      holders: rows.filter((row) => classifyShopRow(row, shopDomain, shopId) === 'match'),
      conflicts: rows.filter((row) => classifyShopRow(row, shopDomain, shopId) === 'conflict'),
    };
  }

  /**
   * Records Shopify's verified numeric shop id on legacy rows that lack one (learned from an HMAC-verified compliance
   * delivery that resolved them by domain alone). Never overwrites an existing id. `conflict` = another live row
   * already carries this id (one store under two domains) — the caller raises a privacy exception.
   */
  async recordShopifyShopId(integrationIds: string[], shopId: string): Promise<'ok' | 'conflict'> {
    if (integrationIds.length === 0) return 'ok';
    try {
      await this.database.client
        .update(integrations)
        .set({ shopifyShopId: shopId })
        .where(and(inArray(integrations.id, integrationIds), isNull(integrations.shopifyShopId)));
      return 'ok';
    } catch (error) {
      if (isLiveShopConflict(error)) return 'conflict';
      throw error;
    }
  }

  /** Ops only: whether a stored credential is past its `expiresAt` (using it would mean a refresh, which rotates it). */
  async isCredentialExpiring(workspaceId: string, provider: IntegrationProvider): Promise<boolean | null> {
    const existing = await this.findByProvider(workspaceId, provider);
    if (!existing?.credentials) return null;
    const { expiresAt } = JSON.parse(decryptCredential(existing.credentials, this.resolveEncryptionKey())) as Record<string, string>;
    return Boolean(expiresAt) && new Date(expiresAt).getTime() <= Date.now() + CREDENTIAL_REFRESH_SKEW_MS;
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
    externalId: string | undefined,
    orderExternalIds: string[] = [],
  ): Promise<{ found: boolean; canonicalCustomerRemoved: boolean; ordersErased: number }> {
    return this.database.transaction(async (tx) => {
      // Shopify's `orders_to_redact`: erased even when the customer row itself is unknown here (e.g. never imported, or
      // already removed), so a redaction never leaves the customer's orders behind.
      const ordersErased = await this.deleteOrdersByExternalId(tx, workspaceId, integrationId, orderExternalIds);
      if (externalId === undefined) {
        return { found: ordersErased > 0, canonicalCustomerRemoved: false, ordersErased };
      }
      const [customerRow] = await tx
        .select({
          id: commerceCustomers.id,
          canonicalCustomerId: commerceCustomers.canonicalCustomerId,
          email: commerceCustomers.email,
          phoneE164: commerceCustomers.phoneE164,
        })
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
        return { found: ordersErased > 0, canonicalCustomerRemoved: false, ordersErased };
      }

      // Unlinked checkout signals carrying this customer's email/phone, or tied to one of their orders by the provider
      // session id, are the same person's data (linked ones go with the canonical customer below when it is orphaned).
      // Order session ids are read before the orders are deleted.
      const orderSessionIds = (
        await tx
          .selectDistinct({ id: commerceOrders.externalCheckoutSessionId })
          .from(commerceOrders)
          .where(and(eq(commerceOrders.workspaceId, workspaceId), eq(commerceOrders.customerId, customerRow.id)))
      ).flatMap((row) => (row.id ? [row.id] : []));
      await this.deleteSourceCustomerWithOrders(tx, workspaceId, customerRow.id);
      const email = customerRow.email?.trim().toLowerCase();
      if (email || customerRow.phoneE164 || orderSessionIds.length > 0) {
        await tx.delete(checkoutSessions).where(
          and(
            eq(checkoutSessions.workspaceId, workspaceId),
            isNull(checkoutSessions.canonicalCustomerId),
            or(
              email ? eq(checkoutSessions.email, email) : undefined,
              customerRow.phoneE164 ? eq(checkoutSessions.phoneE164, customerRow.phoneE164) : undefined,
              orderSessionIds.length > 0 ? inArray(checkoutSessions.externalSessionId, orderSessionIds) : undefined,
            ),
          ),
        );
      }

      const canonicalCustomerRemoved = customerRow.canonicalCustomerId
        ? await this.purgeCanonicalCustomerIfOrphaned(tx, workspaceId, customerRow.canonicalCustomerId)
        : false;

      return { found: true, canonicalCustomerRemoved, ordersErased };
    });
  }

  /** Erases listed orders (by provider order id) of one integration, with their unlinked checkout signals. */
  private async deleteOrdersByExternalId(
    tx: NodePgDatabase,
    workspaceId: string,
    integrationId: string,
    orderExternalIds: string[],
  ): Promise<number> {
    if (orderExternalIds.length === 0) {
      return 0;
    }
    const rows = await tx
      .select({ id: commerceOrders.id, sessionId: commerceOrders.externalCheckoutSessionId })
      .from(commerceOrders)
      .where(
        and(
          eq(commerceOrders.workspaceId, workspaceId),
          eq(commerceOrders.integrationId, integrationId),
          inArray(commerceOrders.externalId, orderExternalIds),
        ),
      );
    if (rows.length === 0) {
      return 0;
    }
    const sessionIds = rows.flatMap((row) => (row.sessionId ? [row.sessionId] : []));
    if (sessionIds.length > 0) {
      await tx
        .delete(checkoutSessions)
        .where(
          and(
            eq(checkoutSessions.workspaceId, workspaceId),
            isNull(checkoutSessions.canonicalCustomerId),
            inArray(checkoutSessions.externalSessionId, sessionIds),
          ),
        );
    }
    await this.deleteOrderRows(tx, workspaceId, rows.map((row) => row.id));
    return rows.length;
  }

  /**
   * Deletes one source customer row and its orders (line items, refunds, fulfillments), inside the caller's
   * transaction. Returns the deleted orders' provider ids. Building block shared by `purgeCommerceCustomer` (Shopify
   * `customers/redact`) and person-level erasure (CustomerErasureService) — not a standalone erasure: the caller
   * decides what happens to the canonical customer afterwards.
   */
  async deleteSourceCustomerWithOrders(tx: NodePgDatabase, workspaceId: string, commerceCustomerId: string): Promise<string[]> {
    const orderRows = await tx
      .select({ id: commerceOrders.id, externalId: commerceOrders.externalId })
      .from(commerceOrders)
      .where(and(eq(commerceOrders.workspaceId, workspaceId), eq(commerceOrders.customerId, commerceCustomerId)));
    await this.deleteOrderRows(
      tx,
      workspaceId,
      orderRows.map((row) => row.id),
    );

    await tx.delete(commerceCustomers).where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.id, commerceCustomerId)));
    return orderRows.map((row) => row.externalId);
  }

  /** Orders and everything hanging off them (line items, refunds, refund line items, fulfillments), FK-safe order. */
  private async deleteOrderRows(tx: NodePgDatabase, workspaceId: string, orderIds: string[]): Promise<void> {
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
    // A checkout source's signals (FlexyPe) — integration-scoped, may carry emails/phones.
    await tx.delete(checkoutSessions).where(and(eq(checkoutSessions.workspaceId, workspaceId), eq(checkoutSessions.integrationId, integrationId)));

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
  /** Tx-scoped building block, also used by CustomerErasureService — erases a canonical customer once no source row references it. */
  async purgeCanonicalCustomerIfOrphaned(tx: NodePgDatabase, workspaceId: string, canonicalCustomerId: string): Promise<boolean> {
    const [remaining] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(commerceCustomers)
      .where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.canonicalCustomerId, canonicalCustomerId)));
    if (Number(remaining?.count ?? 0) > 0) {
      return false;
    }

    // Customers merged into this one are the same person (an owner/admin
    // approved it) and hold no source rows of their own after the merge —
    // erase them too, then the merge history whose snapshots carry both
    // sides' identifiers, before the rows those reference.
    const mergedIn = await tx
      .select({ id: canonicalCustomers.id })
      .from(canonicalCustomers)
      .where(and(eq(canonicalCustomers.workspaceId, workspaceId), eq(canonicalCustomers.mergedIntoId, canonicalCustomerId)));
    for (const merged of mergedIn) {
      await this.purgeCanonicalCustomerIfOrphaned(tx, workspaceId, merged.id);
    }
    await tx
      .delete(identityMergeHistory)
      .where(
        and(
          eq(identityMergeHistory.workspaceId, workspaceId),
          or(eq(identityMergeHistory.survivingCanonicalCustomerId, canonicalCustomerId), eq(identityMergeHistory.mergedCanonicalCustomerId, canonicalCustomerId)),
        ),
      );

    await tx.delete(recommendations).where(and(eq(recommendations.workspaceId, workspaceId), eq(recommendations.canonicalCustomerId, canonicalCustomerId)));
    await tx.delete(checkoutSessions).where(and(eq(checkoutSessions.workspaceId, workspaceId), eq(checkoutSessions.canonicalCustomerId, canonicalCustomerId)));
    await tx.delete(internalNotifications).where(and(eq(internalNotifications.workspaceId, workspaceId), eq(internalNotifications.canonicalCustomerId, canonicalCustomerId)));
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

    // Memory and its history are customer personal data — permanently erased, history first (FK).
    const memoryRows = await tx
      .select({ id: customerMemoryEntries.id })
      .from(customerMemoryEntries)
      .where(and(eq(customerMemoryEntries.workspaceId, workspaceId), eq(customerMemoryEntries.canonicalCustomerId, canonicalCustomerId)));
    const memoryIds = memoryRows.map((row) => row.id);
    if (memoryIds.length > 0) {
      await tx.delete(customerMemoryEntryHistory).where(and(eq(customerMemoryEntryHistory.workspaceId, workspaceId), inArray(customerMemoryEntryHistory.memoryEntryId, memoryIds)));
    }
    await tx.delete(customerMemoryEntries).where(and(eq(customerMemoryEntries.workspaceId, workspaceId), eq(customerMemoryEntries.canonicalCustomerId, canonicalCustomerId)));
    // Preferences + history: same rule as memory.
    const preferenceRows = await tx
      .select({ id: customerPreferences.id })
      .from(customerPreferences)
      .where(and(eq(customerPreferences.workspaceId, workspaceId), eq(customerPreferences.canonicalCustomerId, canonicalCustomerId)));
    const preferenceIds = preferenceRows.map((row) => row.id);
    if (preferenceIds.length > 0) {
      await tx.delete(customerPreferenceHistory).where(and(eq(customerPreferenceHistory.workspaceId, workspaceId), inArray(customerPreferenceHistory.preferenceId, preferenceIds)));
    }
    await tx.delete(customerPreferences).where(and(eq(customerPreferences.workspaceId, workspaceId), eq(customerPreferences.canonicalCustomerId, canonicalCustomerId)));
    await tx.delete(customerSummaries).where(and(eq(customerSummaries.workspaceId, workspaceId), eq(customerSummaries.canonicalCustomerId, canonicalCustomerId)));
    // Linked website visitors are this person's data (identity_signal payloads hold their email) — deleted, not unlinked; events → sessions → visitors (FK).
    const visitorRows = await tx
      .select({ id: websiteVisitors.id })
      .from(websiteVisitors)
      .where(and(eq(websiteVisitors.workspaceId, workspaceId), eq(websiteVisitors.canonicalCustomerId, canonicalCustomerId)));
    const visitorIds = visitorRows.map((row) => row.id);
    if (visitorIds.length > 0) {
      await tx.delete(websiteEvents).where(and(eq(websiteEvents.workspaceId, workspaceId), inArray(websiteEvents.visitorId, visitorIds)));
      await tx.delete(websiteSessions).where(and(eq(websiteSessions.workspaceId, workspaceId), inArray(websiteSessions.visitorId, visitorIds)));
      await tx.delete(websiteVisitors).where(and(eq(websiteVisitors.workspaceId, workspaceId), inArray(websiteVisitors.id, visitorIds)));
    }

    // AI action audit records are metadata-only (no personal data) and stay as the audit trail; only their link to
    // the erased customer is cleared — otherwise the customer_id foreign key blocks the whole erasure.
    await tx
      .update(aiActionRequests)
      .set({ customerId: null })
      .where(and(eq(aiActionRequests.workspaceId, workspaceId), eq(aiActionRequests.customerId, canonicalCustomerId)));

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
      // Nothing is written on a failed (re)connect: the previous working credentials stay as they were.
      throw new UnauthenticatedError('Could not verify these credentials with the provider.');
    }
    // Only after verification: an unverified caller must not learn whether a store is connected to BRAYN.
    if (provider === 'shopify' && credentials.shopDomain && (await this.isStoreHeldElsewhere(workspaceId, credentials.shopDomain))) {
      throw new ConflictError(STORE_OWNED_ELSEWHERE_MESSAGE);
    }

    const toStore = adapter.mergeReconnectCredentials
      ? adapter.mergeReconnectCredentials(await this.getCredentials(workspaceId, provider), credentials)
      : credentials;
    await this.setCredentials(workspaceId, provider, toStore);
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
    // see findAllByShopDomain(). Only ever set from what the credential payload
    // itself carries, never guessed. Lowercased: the store-ownership index compares lower(shop_domain).
    try {
      await this.database.client
        .update(integrations)
        .set({ credentials: encrypted, ...(credentials.shopDomain ? { shopDomain: credentials.shopDomain.toLowerCase() } : {}) })
        .where(eq(integrations.id, existing.id));
    } catch (error) {
      rethrowLiveShopConflict(error);
    }
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
