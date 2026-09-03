import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { EventBus } from './event-bus.service';

/**
 * Worker structure convention: a domain reacts to an event by injecting
 * EventBus's underlying EventEmitter2 pattern via `@OnEvent(type)` on a
 * provider method (from '@nestjs/event-emitter'), e.g.:
 *
 *   @OnEvent('customer.created')
 *   async handleCustomerCreated(event: DomainEvent<CustomerCreatedPayload>) { ... }
 *
 * That handler runs in-process, asynchronously, off the request that
 * triggered emit() — no separate worker deployment exists or is needed
 * yet. Publishers exist today (integration sync/import/reconciliation/
 * webhook, `customer_health.recalculated`, `revenue_opportunity.created`)
 * but no handler exists yet — nothing consumes them until Business Action
 * Automation (doc19 Phase 15) is built.
 */
@Global()
@Module({
  imports: [EventEmitterModule.forRoot()],
  providers: [EventBus],
  exports: [EventBus],
})
export class EventsModule {}
