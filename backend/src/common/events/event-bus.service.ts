import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { StructuredLoggerService } from '../logging/structured-logger.service';
import type { DomainEvent } from './domain-event';

/**
 * In-process event bus. NOT a durable queue — "the exact queue
 * technology is intentionally deferred" (doc 29 §17, §32) and must not
 * be guessed. This is the "lightweight processing... preferred
 * initially" doc 29 §17 asks for: same-process pub/sub via
 * EventEmitter2, with no persistence or cross-process delivery.
 *
 * A durable/distributed queue (BullMQ, SQS, ...) gets introduced later,
 * exactly when doc 29 says: "when required by workload, reliability,
 * retries, execution guarantees, scalability." No domain has that
 * requirement yet — nothing publishes through this today.
 */
@Injectable()
export class EventBus {
  constructor(
    private readonly emitter: EventEmitter2,
    private readonly logger: StructuredLoggerService,
  ) {}

  emit<TPayload>(event: DomainEvent<TPayload>): void {
    this.logger.event('log', event.type, 'EventBus', {
      eventId: event.id,
      workspaceId: event.workspaceId,
      idempotencyKey: event.idempotencyKey,
    });
    this.emitter.emit(event.type, event);
  }
}
