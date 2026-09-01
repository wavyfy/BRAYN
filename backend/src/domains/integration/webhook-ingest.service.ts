import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { ConflictError, NotFoundError, ProviderError, UnauthenticatedError } from '../../common/errors/app-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { createEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { IntegrationService } from './integration.service';
import { ProviderRegistry } from './provider-registry.service';
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
    private readonly idempotency: IdempotencyService,
    private readonly eventBus: EventBus,
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
    const secret = credentials?.webhookSecret;
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

    const idempotencyKey = `webhook:${integration.id}:${parsed.externalEventId}`;
    const reserved = await this.idempotency.reserve(idempotencyKey);
    if (!reserved) {
      return { status: 'duplicate' };
    }

    const [row] = await this.database.client
      .insert(integrationWebhookEvents)
      .values({
        workspaceId,
        integrationId: integration.id,
        externalEventId: parsed.externalEventId,
        eventType: parsed.eventType,
      })
      .returning();

    try {
      this.eventBus.emit(
        createEvent({
          type: 'integration.webhook.received',
          workspaceId,
          entityId: integration.id,
          idempotencyKey,
          payload: { provider, eventType: parsed.eventType, payload: parsed.payload },
        }),
      );

      await this.database.client
        .update(integrationWebhookEvents)
        .set({ status: 'processed', processedAt: new Date() })
        .where(eq(integrationWebhookEvents.id, row.id));
      await this.idempotency.complete(idempotencyKey);

      return { status: 'accepted', webhookEventId: row.id };
    } catch (error) {
      await this.database.client
        .update(integrationWebhookEvents)
        .set({ status: 'failed', error: error instanceof Error ? error.message : 'Unknown error' })
        .where(eq(integrationWebhookEvents.id, row.id));
      throw error;
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
