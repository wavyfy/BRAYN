import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { withRetry } from '../../common/async/retry';
import { createEvent, type DomainEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { scrubSensitive } from '../../common/logging/scrub-sensitive';
import { CustomerService } from '../commerce/customer.service';
import { ProductService } from '../commerce/product.service';
import { OrderService } from '../commerce/order.service';
import { CollectionService } from '../commerce/collection.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { isWebhookResourceEvent, type WebhookResourceEvent } from './provider-adapter.interface';
import type { IntegrationProvider } from './dto/connect-integration.schema';

const MAX_ATTEMPTS = 3;

interface WebhookReceivedPayload {
  provider: IntegrationProvider;
  eventType: string;
  payload: unknown;
  webhookEventId: string;
}

/** Doc10 — "Order Placed" is a significant Customer Health event. Emitted only for a webhook-delivered order that was genuinely just inserted (see OrderService.upsertMany's doc comment) — never for a bulk import/sync/reconciliation pass, which represents pre-existing order history, not a new order being placed. */
export interface OrderCreatedPayload {
  canonicalCustomerId: string;
}

/**
 * Applies a single webhook-delivered record to commerce data (doc 06 —
 * Integration produces normalized data, the owning domain stores it).
 * Reacts to `integration.webhook.received` off the request that ingested
 * it (doc 07 — event/job, not direct call: WebhookIngestService's own job
 * ends at "produced a domain event", same boundary ImportProcessorService
 * sits behind for imports).
 *
 * Doc 21 "Processing Failure" / doc 07 "Job Lifecycle" — a transient
 * failure gets `withRetry`'s in-process backoff; once that's exhausted the
 * delivery moves to `dead_letter` on its own row (retryable via
 * WebhookIngestService.replay) rather than being retried forever or
 * silently dropped. Never rethrown — EventBus.emit is fire-and-forget
 * (doc 07: "the event system must not become the location for business
 * logic"), and this consumer's failure must not un-process an
 * already-persisted, already-deduplicated webhook delivery.
 *
 * The `order` case additionally emits `order.created` (see
 * OrderCreatedPayload's doc comment) for a genuinely new order —
 * `CustomerHealthService` is the first (and, for now, only) consumer.
 * That emit happens after `orderService.upsertMany()` has already
 * returned, so a retried/replayed delivery's own idempotent re-upsert
 * (order already exists) naturally yields no new-order id to emit for —
 * no separate dedup bookkeeping needed here.
 */
@Injectable()
export class WebhookEventProcessorService {
  constructor(
    private readonly database: DatabaseService,
    private readonly customerService: CustomerService,
    private readonly productService: ProductService,
    private readonly orderService: OrderService,
    private readonly collectionService: CollectionService,
    private readonly identityResolutionService: IdentityResolutionService,
    private readonly eventBus: EventBus,
    private readonly logger: StructuredLoggerService,
  ) {}

  @OnEvent('integration.webhook.received')
  async handleWebhookReceived(event: DomainEvent<WebhookReceivedPayload>): Promise<void> {
    const workspaceId = event.workspaceId;
    const integrationId = event.entityId;
    const { provider, payload, webhookEventId } = event.payload;
    if (!workspaceId || !integrationId || !isWebhookResourceEvent(payload)) {
      return;
    }

    try {
      await withRetry(() => this.applyResource(workspaceId, integrationId, provider, payload), {
        maxAttempts: MAX_ATTEMPTS,
      });

      await this.database.client
        .update(integrationWebhookEvents)
        .set({ status: 'processed', error: null, retryCount: 0 })
        .where(eq(integrationWebhookEvents.id, webhookEventId));
    } catch (error) {
      // Persisted alongside the row (doc 21 "Processing Failure") — scrubbed
      // like any other log destination, since this text is the same
      // unstructured error message a log line would otherwise carry.
      const message = scrubSensitive(error instanceof Error ? error.message : 'Unknown error');
      this.logger.error(
        'Failed to apply webhook-delivered record to commerce data after retries — moved to dead_letter',
        error instanceof Error ? error.stack : undefined,
        'WebhookEventProcessorService',
      );

      await this.database.client
        .update(integrationWebhookEvents)
        .set({ status: 'dead_letter', error: message, retryCount: MAX_ATTEMPTS })
        .where(eq(integrationWebhookEvents.id, webhookEventId));
    }
  }

  private async applyResource(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    payload: WebhookResourceEvent,
  ): Promise<void> {
    switch (payload.resource) {
      case 'customer':
        await this.customerService.upsertMany(workspaceId, integrationId, provider, [payload.data]);
        await this.identityResolutionService.resolveMany(workspaceId, provider, [payload.data.externalId]);
        break;
      case 'product':
        await this.productService.upsertMany(workspaceId, integrationId, provider, [payload.data]);
        break;
      case 'order': {
        const { newOrderCanonicalCustomerIds } = await this.orderService.upsertMany(workspaceId, integrationId, provider, [payload.data]);
        for (const canonicalCustomerId of newOrderCanonicalCustomerIds) {
          this.eventBus.emit(
            createEvent<OrderCreatedPayload>({ type: 'order.created', workspaceId, payload: { canonicalCustomerId } }),
          );
        }
        break;
      }
      case 'fulfillment':
        await this.orderService.upsertFulfillments(workspaceId, integrationId, provider, [payload.data]);
        break;
      case 'collection':
        await this.collectionService.upsertMany(workspaceId, integrationId, provider, [payload.data]);
        break;
    }
  }
}
