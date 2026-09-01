import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { DomainEvent } from '../../common/events/domain-event';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { CustomerService } from '../commerce/customer.service';
import { ProductService } from '../commerce/product.service';
import { OrderService } from '../commerce/order.service';
import { isWebhookResourceEvent } from './provider-adapter.interface';
import type { IntegrationProvider } from './dto/connect-integration.schema';

interface WebhookReceivedPayload {
  provider: IntegrationProvider;
  eventType: string;
  payload: unknown;
}

/**
 * Applies a single webhook-delivered record to commerce data (doc 06 —
 * Integration produces normalized data, the owning domain stores it).
 * Reacts to `integration.webhook.received` off the request that ingested
 * it (doc 07 — event/job, not direct call: WebhookIngestService's own job
 * ends at "produced a domain event", same boundary ImportProcessorService
 * sits behind for imports).
 *
 * Errors here are caught and logged rather than rethrown — EventBus.emit
 * is fire-and-forget (doc 07: "the event system must not become the
 * location for business logic", and this consumer's failure must not
 * un-process an already-persisted, already-deduplicated webhook delivery.
 * No retry/dead-letter handling yet — that's doc 19's dedicated
 * "Retry/error handling" part.
 */
@Injectable()
export class WebhookEventProcessorService {
  constructor(
    private readonly customerService: CustomerService,
    private readonly productService: ProductService,
    private readonly orderService: OrderService,
    private readonly logger: StructuredLoggerService,
  ) {}

  @OnEvent('integration.webhook.received')
  async handleWebhookReceived(event: DomainEvent<WebhookReceivedPayload>): Promise<void> {
    const workspaceId = event.workspaceId;
    const integrationId = event.entityId;
    const { provider, payload } = event.payload;
    if (!workspaceId || !integrationId || !isWebhookResourceEvent(payload)) {
      return;
    }

    try {
      switch (payload.resource) {
        case 'customer':
          await this.customerService.upsertMany(workspaceId, integrationId, provider, [payload.data]);
          break;
        case 'product':
          await this.productService.upsertMany(workspaceId, integrationId, provider, [payload.data]);
          break;
        case 'order':
          await this.orderService.upsertMany(workspaceId, integrationId, provider, [payload.data]);
          break;
      }
    } catch (error) {
      this.logger.error(
        'Failed to apply webhook-delivered record to commerce data',
        error instanceof Error ? error.stack : undefined,
        'WebhookEventProcessorService',
      );
    }
  }
}
