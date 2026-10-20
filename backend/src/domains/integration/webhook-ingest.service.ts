import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { ConflictError, NotFoundError, ProviderError, UnauthenticatedError } from '../../common/errors/app-error';
import { createEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { IntegrationService } from './integration.service';
import { ProviderRegistry } from './provider-registry.service';
import type { WebhookReceivedPayload } from './webhook-event-processor.service';
import type { IntegrationProvider } from './dto/connect-integration.schema';

export type WebhookIngestResult =
  | { status: 'accepted'; webhookEventId: string }
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

    const credentials = await this.integrationService.getCredentials(workspaceId, provider);
    const secret = adapter.resolveWebhookSecret ? adapter.resolveWebhookSecret(credentials) : credentials?.webhookSecret;
    if (!secret) {
      throw new ProviderError('No webhook secret is configured for this integration.');
    }

    if (!adapter.verifyWebhookSignature(rawBody, headers, secret)) {
      throw new UnauthenticatedError('Webhook signature verification failed.');
    }

    const parsed = adapter.parseWebhookEvent(rawBody, headers);
    if (!parsed) {
      return { status: 'ignored' };
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
        payload: parsed.payload,
      })
      .onConflictDoNothing({ target: [integrationWebhookEvents.integrationId, integrationWebhookEvents.externalEventId] })
      .returning({ id: integrationWebhookEvents.id });

    if (!row) {
      return { status: 'duplicate' };
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

  private async findIntegration(workspaceId: string, provider: IntegrationProvider) {
    const [integration] = await this.database.client
      .select({ id: integrations.id, status: integrations.status })
      .from(integrations)
      .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider)))
      .limit(1);

    return integration ?? null;
  }
}
