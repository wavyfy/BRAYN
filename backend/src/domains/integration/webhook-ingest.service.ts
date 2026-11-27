import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { isStoreDomainOf } from './integration.service';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { ConflictError, NotFoundError, ProviderError, UnauthenticatedError, UnauthorizedError } from '../../common/errors/app-error';
import { createEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { IntegrationService } from './integration.service';
import { ProviderRegistry } from './provider-registry.service';
import type { WebhookReceivedPayload } from './webhook-event-processor.service';
import type { IntegrationProvider } from './dto/connect-integration.schema';

export type WebhookIngestResult =
  | { status: 'accepted'; webhookEventId: string }
  | { status: 'quarantined'; webhookEventId: string }
  | { status: 'duplicate' }
  | { status: 'ignored' };

/**
 * Drives the generic webhook pipeline (doc 21 — Webhook Contract):
 * Endpoint → Authenticity Verification → Payload Validation → Workspace/
 * Integration Resolution → Deduplication → Persist → Domain Event.
 * Provider-specific signature verification and payload parsing stay
 * behind ProviderAdapter (doc 06 — Provider Isolation); this service owns
 * everything else and never depends on a provider's payload shape.
 *
 * Ack semantics: `accepted`/`duplicate` (HTTP 200) means the delivery is
 * durably persisted as a `pending` work item — not that it has been
 * processed. WebhookEventProcessorService processes it afterwards and
 * recovers it across crashes/restarts. Any failure before the row commits
 * throws (non-2xx), so the provider retries.
 *
 * Called from WebhookController — a `@Public()` route, since a provider's
 * webhook delivery carries no Clerk session; the signature check here
 * (via the adapter, using this integration's stored secret) is this
 * request's actual authentication.
 */
@Injectable()
export class WebhookIngestService {
  constructor(
    private readonly database: DatabaseService,
    private readonly integrationService: IntegrationService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly eventBus: EventBus,
    private readonly logger: StructuredLoggerService,
  ) {}

  async ingest(
    workspaceId: string,
    provider: IntegrationProvider,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<WebhookIngestResult> {
    const integration = await this.findIntegration(workspaceId, provider);
    if (!integration) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }
    if (integration.status === 'disconnected') {
      throw new ConflictError('Cannot process a webhook for a disconnected integration.');
    }

    const adapter = this.providerRegistry.get(provider);
    if (!adapter.verifyWebhookSignature || !adapter.parseWebhookEvent) {
      throw new ProviderError(`Provider "${provider}" does not support webhooks.`);
    }

    // Authenticate before any side effect: the app-level secret (no credential access at all) first; only if that
    // doesn't verify, a per-integration secret read from the stored credentials WITHOUT the refresh-on-read — a
    // webhook (signed or not) must never trigger a token refresh/rotation.
    const appSecret = adapter.resolveWebhookSecret?.(null) ?? null;
    let verified = Boolean(appSecret) && adapter.verifyWebhookSignature(rawBody, headers, appSecret!);
    if (!verified) {
      const stored = await this.integrationService.getStoredCredentials(workspaceId, provider);
      const secret = adapter.resolveWebhookSecret ? adapter.resolveWebhookSecret(stored) : stored?.webhookSecret;
      if (!secret) {
        throw new ProviderError('No webhook secret is configured for this integration.');
      }
      verified = secret !== appSecret && adapter.verifyWebhookSignature(rawBody, headers, secret);
    }
    if (!verified) {
      throw new UnauthenticatedError('Webhook signature verification failed.');
    }

    const parsed = adapter.parseWebhookEvent(rawBody, headers);
    if (!parsed) {
      return { status: 'ignored' };
    }
    // A delivery naming its own provider's store (Shopify) whose shop isn't this integration's store is quarantined:
    // stored and acknowledged (a rejection would make Shopify retry and eventually drop the subscription) but never
    // processed — alerted through the compliance monitor and released only by an operator. A signal source bound to
    // another provider's store (FlexyPe) is still rejected.
    let quarantine: string | null = null;
    if (parsed.store !== undefined) {
      const mismatch = await this.workspaceStoreMismatch(workspaceId, provider, parsed.store);
      if (mismatch && parsed.store.provider === provider) {
        quarantine = mismatch;
      } else if (mismatch) {
        throw new UnauthorizedError('This delivery is for a store that is not connected to this workspace.');
      }
    }

    // The durable row is both the dedup and the acknowledgement: once this
    // insert commits, the delivery is BRAYN's to process (see
    // integration_webhook_events' lifecycle). A conflict means this delivery
    // already has a row — in any state, it's already durably owned, so a
    // redelivery is acknowledged without creating anything.
    const [row] = await this.database.client
      .insert(integrationWebhookEvents)
      .values({
        workspaceId,
        integrationId: integration.id,
        externalEventId: parsed.externalEventId,
        eventType: parsed.eventType,
        // A quarantined payload may be another store's customer data: sealed with the credential key (readable only in
        // the production runtime), with the received shop kept beside it for the release check.
        payload: quarantine ? this.integrationService.sealJson(parsed.payload, { shop: parsed.store?.domain ?? '' }) : parsed.payload,
        ...(quarantine ? { status: 'quarantined' as const, error: quarantine } : {}),
      })
      .onConflictDoNothing({ target: [integrationWebhookEvents.integrationId, integrationWebhookEvents.externalEventId] })
      .returning({ id: integrationWebhookEvents.id });

    if (!row) {
      return { status: 'duplicate' };
    }
    if (quarantine) {
      return { status: 'quarantined', webhookEventId: row.id };
    }

    this.wake(workspaceId, integration.id, row.id);
    return { status: 'accepted', webhookEventId: row.id };
  }

  /**
   * Manual recovery for a dead-lettered delivery (doc 21/18 — "Manual
   * recovery where required", "Replay where safe"): puts the
   * already-verified, already-deduplicated row back to `pending` with a
   * fresh attempt budget — processed from its stored `payload`, no
   * signature re-check, since it isn't a new delivery. Durable like any
   * other pending row: the wake-up is only a shortcut.
   */
  async replay(workspaceId: string, webhookEventId: string): Promise<{ status: 'accepted' }> {
    const t = integrationWebhookEvents;
    const [requeued] = await this.database.client
      .update(t)
      // DB clock, never the app clock: claim() compares against `now()`, so an app clock running ahead would leave the row "not yet due" and skip the wake-up.
      .set({ status: 'pending', retryCount: 0, nextAttemptAt: sql`now()`, error: null })
      .where(and(eq(t.id, webhookEventId), eq(t.workspaceId, workspaceId), eq(t.status, 'dead_letter')))
      .returning({ id: t.id, integrationId: t.integrationId });

    if (!requeued) {
      const [existing] = await this.database.client
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.id, webhookEventId), eq(t.workspaceId, workspaceId)))
        .limit(1);
      if (!existing) {
        throw new NotFoundError('No webhook event with that id exists in this workspace.');
      }
      throw new ConflictError('Only a dead-lettered webhook event can be replayed.');
    }

    this.wake(workspaceId, requeued.integrationId, requeued.id);
    return { status: 'accepted' };
  }

  /**
   * Ops only (operator confirmed the delivery belongs to this store, e.g. after recording an alias): puts a quarantined
   * row back to `pending` for normal processing.
   */
  async releaseQuarantined(webhookEventId: string): Promise<{ status: 'accepted' }> {
    const t = integrationWebhookEvents;
    const [held] = await this.database.client
      .select({ payload: t.payload, shopDomain: integrations.shopDomain, shopDomainAliases: integrations.shopDomainAliases, status: integrations.status })
      .from(t)
      .innerJoin(integrations, eq(integrations.id, t.integrationId))
      .where(and(eq(t.id, webhookEventId), eq(t.status, 'quarantined')))
      .limit(1);
    if (!held) {
      throw new NotFoundError('No quarantined webhook event with that id.');
    }
    // Release is not an override: the received shop must now be this integration's store (or a verified alias).
    const shop = (held.payload as { meta?: { shop?: unknown } } | null)?.meta?.shop;
    if (held.status === 'disconnected' || typeof shop !== 'string' || !shop || !isStoreDomainOf(held, shop)) {
      throw new ConflictError('This delivery\'s shop is still not the integration\'s store; record a verified alias first.');
    }
    const [released] = await this.database.client
      .update(t)
      .set({ status: 'pending', retryCount: 0, nextAttemptAt: sql`now()`, error: null })
      .where(and(eq(t.id, webhookEventId), eq(t.status, 'quarantined')))
      .returning({ id: t.id, integrationId: t.integrationId, workspaceId: t.workspaceId });
    if (!released) {
      throw new NotFoundError('No quarantined webhook event with that id.');
    }
    this.wake(released.workspaceId, released.integrationId, released.id);
    return { status: 'accepted' };
  }

  /** Best-effort immediate processing; correctness never depends on it — the recovery poller claims the row regardless. */
  private wake(workspaceId: string, integrationId: string, webhookEventId: string): void {
    try {
      this.eventBus.emit(
        createEvent<WebhookReceivedPayload>({
          type: 'integration.webhook.received',
          workspaceId,
          entityId: integrationId,
          payload: { webhookEventId },
        }),
      );
    } catch (error) {
      this.logger.event('warn', 'Webhook wake-up emit failed; the recovery poller will process the row', 'WebhookIngestService', {
        webhookEventId,
        integrationId,
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Workspace isolation for a signal source bound to a commerce store: the delivery's store must be this workspace's
   * connected store on the provider the adapter names. A valid secret alone isn't enough — a secret configured on another store's account (or a
   * copy-paste between workspaces) would otherwise attach that store's shoppers to this workspace. Rejected before
   * anything is stored; the provider sees the failure in its delivery log.
   */
  private async workspaceStoreMismatch(
    workspaceId: string,
    provider: IntegrationProvider,
    store: { provider: IntegrationProvider; domain: string },
  ): Promise<string | null> {
    const [owner] = await this.database.client
      .select({ shopDomain: integrations.shopDomain, shopDomainAliases: integrations.shopDomainAliases, status: integrations.status })
      .from(integrations)
      .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, store.provider)))
      .limit(1);
    const connected = owner && owner.status !== 'disconnected' && owner.shopDomain ? owner : undefined;
    const storeDomain = store.domain.toLowerCase();
    if (connected && storeDomain && isStoreDomainOf(connected, storeDomain)) {
      return null;
    }
    const reason = !connected ? 'no_connected_store' : storeDomain ? 'store_mismatch' : 'store_missing';
    this.logger.event('warn', 'Webhook for a store that is not this workspace\'s connected store', 'WebhookIngestService', {
      workspaceId,
      provider,
      storeDomain,
      storeProvider: store.provider,
      reason,
    });
    // Recorded on a quarantined row (domain names only — not personal data) so an operator can decide on an alias.
    return `${reason}: received ${storeDomain || '(none)'}`.slice(0, 200);
  }

  private async findIntegration(workspaceId: string, provider: IntegrationProvider) {
    const [integration] = await this.database.client
      .select({ id: integrations.id, status: integrations.status })
      .from(integrations)
      .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider)))
      .limit(1);

    return integration ?? null;
  }
}
