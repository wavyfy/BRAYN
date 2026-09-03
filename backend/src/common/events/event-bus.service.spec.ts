import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { OnEvent } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { EventsModule } from './events.module';
import { EventBus } from './event-bus.service';
import { createEvent, type DomainEvent } from './domain-event';
import { LoggingModule } from '../logging/logging.module';

interface WidgetCreatedPayload {
  widgetId: string;
}

@Injectable()
class WidgetCreatedListener {
  received: DomainEvent<WidgetCreatedPayload>[] = [];

  @OnEvent('widget.created')
  handle(event: DomainEvent<WidgetCreatedPayload>): void {
    this.received.push(event);
  }
}

describe('EventBus', () => {
  it('delivers an emitted event to its @OnEvent listener', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule, LoggingModule],
      providers: [WidgetCreatedListener],
    }).compile();

    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();

    const bus = app.get(EventBus);
    const listener = app.get(WidgetCreatedListener);

    const event = createEvent<WidgetCreatedPayload>({
      type: 'widget.created',
      payload: { widgetId: 'w_1' },
    });
    bus.emit(event);

    // EventEmitter2's default dispatch is synchronous for sync handlers.
    expect(listener.received).toHaveLength(1);
    expect(listener.received[0]?.payload.widgetId).toBe('w_1');
    expect(listener.received[0]?.type).toBe('widget.created');

    await app.close();
  });

  it('does not deliver an event to a listener for a different type', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule, LoggingModule],
      providers: [WidgetCreatedListener],
    }).compile();

    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();

    const bus = app.get(EventBus);
    const listener = app.get(WidgetCreatedListener);

    bus.emit(createEvent({ type: 'widget.deleted', payload: { widgetId: 'w_2' } }));

    expect(listener.received).toHaveLength(0);

    await app.close();
  });
});

describe('createEvent', () => {
  it('fills in id, occurredAt, and defaults version to 1', () => {
    const event = createEvent({ type: 'widget.created', payload: { widgetId: 'w_3' } });

    expect(typeof event.id).toBe('string');
    expect(event.id.length).toBeGreaterThan(0);
    expect(event.version).toBe(1);
    expect(() => new Date(event.occurredAt).toISOString()).not.toThrow();
  });

  it('respects an explicit version and idempotencyKey', () => {
    const event = createEvent({
      type: 'widget.created',
      payload: { widgetId: 'w_4' },
      version: 2,
      idempotencyKey: 'key-123',
    });

    expect(event.version).toBe(2);
    expect(event.idempotencyKey).toBe('key-123');
  });
});

describe('EventBus logging', () => {
  it('logs the event type and id without throwing when no listener exists', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [EventsModule, LoggingModule],
    }).compile();

    const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();

    const bus = app.get(EventBus);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(() => bus.emit(createEvent({ type: 'widget.orphaned', payload: {} }))).not.toThrow();
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
    await app.close();
  });
});
