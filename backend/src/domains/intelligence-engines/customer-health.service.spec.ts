import { describe, expect, it, vi } from 'vitest';
import { CustomerHealthService } from './customer-health.service';
import type { DatabaseService } from '../../database/database.service';
import type { DomainEvent } from '../../common/events/domain-event';
import type { EventBus } from '../../common/events/event-bus.service';
import type { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import type { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import type { OrderCreatedPayload } from '../integration/webhook-event-processor.service';

function makeEventBus() {
  return { emit: vi.fn() } as unknown as EventBus;
}

function makeLogger() {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => result),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

function makeInsertChain() {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(async () => undefined),
  };
  return chain;
}

function makeCustomerIntelligenceService(
  commerceContext: { lastOrderAt: Date | null; ordersLast90Days: number },
  behaviouralContext: { eventsCount: number; lastActivityAt: Date | null } = { eventsCount: 0, lastActivityAt: null },
): CustomerIntelligenceService {
  return {
    getCustomer: vi.fn(async () => ({
      canonicalCustomerId: 'canon_1',
      profile: { email: null, firstName: null, lastName: null, phone: null },
      sourceCustomers: [],
      commerceContext: { ordersCount: 0, totalSpent: '0', recentOrders: [], ...commerceContext },
      behaviouralContext: { recentEvents: [], ...behaviouralContext },
    })),
  } as unknown as CustomerIntelligenceService;
}

describe('CustomerHealthService', () => {
  describe('recalculate()', () => {
    it('withholds score/healthCategory/trend — only 65% of the signal weight is available', async () => {
      const stateInsert = makeInsertChain();
      const historyInsert = { values: vi.fn(async () => undefined) };
      const insert = vi.fn().mockReturnValueOnce(stateInsert).mockReturnValueOnce(historyInsert);
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      expect(result.score).toBeNull();
      expect(result.healthCategory).toBeNull();
      expect(result.trend).toBeNull();
      expect(result.reasonCodes.at(-1)).toContain('withheld');
    });

    it('computes a recency score of 0 and a reason code when there are no orders on record', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      expect(result.signals).toMatchObject({ purchaseRecency: { available: true, value: null, score: 0 } });
      expect(result.reasonCodes[0]).toContain('No orders on record');
    });

    it('computes a decayed recency score based on days since the last order', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert };
      const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: fortyFiveDaysAgo, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      const recency = (result.signals as Record<string, { value: number; score: number }>).purchaseRecency;
      expect(recency.value).toBe(45);
      expect(recency.score).toBe(50); // halfway through the 90-day decay window
    });

    it('caps the frequency score at 100 once orders reach the target threshold', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: new Date(), ordersLast90Days: 10 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      const frequency = (result.signals as Record<string, { value: number; score: number }>).purchaseFrequency;
      expect(frequency.value).toBe(10);
      expect(frequency.score).toBe(100);
    });

    it('marks WhatsApp/email/customer-experience signals unavailable, each with a reason', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      const signals = result.signals as Record<string, { available: boolean; reason?: string }>;
      expect(signals.whatsappEngagement).toMatchObject({ available: false });
      expect(signals.emailEngagement).toMatchObject({ available: false });
      expect(signals.customerExperience).toMatchObject({ available: false });
      expect(signals.emailEngagement.reason).toContain('product decision');
    });

    it('marks website engagement available with a score of 0 when no website activity exists', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      const signals = result.signals as Record<string, { available: boolean; value: number; score: number }>;
      expect(signals.websiteEngagement).toMatchObject({ available: true, value: 0, score: 0 });
      expect(result.reasonCodes).toContainEqual(expect.stringContaining('No website activity recorded'));
    });

    it('computes a blended recency/frequency website engagement score when behavioural data exists', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert };
      const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
      const customerIntelligenceService = makeCustomerIntelligenceService(
        { lastOrderAt: null, ordersLast90Days: 0 },
        { eventsCount: 20, lastActivityAt: fifteenDaysAgo },
      );
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      const website = (result.signals as Record<string, { value: number; score: number }>).websiteEngagement;
      // recency: 100 - (15/30)*100 = 50; frequency: min(100, (20/20)*100) = 100; blend: 50*0.6 + 100*0.4 = 70
      expect(website.value).toBe(20);
      expect(website.score).toBe(70);
    });

    it('caps the website frequency sub-score at 100 once events reach the target threshold', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService(
        { lastOrderAt: null, ordersLast90Days: 0 },
        { eventsCount: 500, lastActivityAt: new Date() },
      );
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      const website = (result.signals as Record<string, { value: number; score: number }>).websiteEngagement;
      // recency: same-day -> 100; frequency: capped at 100; blend: 100*0.6 + 100*0.4 = 100
      expect(website.score).toBe(100);
    });

    it('scopes the website engagement signal to the requested workspace via getCustomer', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService(
        { lastOrderAt: null, ordersLast90Days: 0 },
        { eventsCount: 5, lastActivityAt: new Date() },
      );
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      await service.recalculate('ws_other', 'canon_1');

      // behaviouralContext is workspace-scoped by CustomerIntelligenceService.getCustomer itself
      // (Part 4) — CustomerHealthService's only isolation obligation is to call it with the
      // requested workspaceId rather than caching/reusing a different workspace's record.
      expect(customerIntelligenceService.getCustomer).toHaveBeenCalledWith('ws_other', 'canon_1');
    });

    it('writes both the current state (upsert) and a history row', async () => {
      const stateInsert = makeInsertChain();
      const historyInsert = { values: vi.fn(async () => undefined) };
      const insert = vi.fn().mockReturnValueOnce(stateInsert).mockReturnValueOnce(historyInsert);
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      await service.recalculate('ws_1', 'canon_1');

      expect(stateInsert.values).toHaveBeenCalledTimes(1);
      expect(stateInsert.onConflictDoUpdate).toHaveBeenCalledTimes(1);
      expect(historyInsert.values).toHaveBeenCalledTimes(1);
    });

    it('emits customer_health.recalculated after every recalculation', async () => {
      const insert = vi.fn().mockReturnValueOnce(makeInsertChain()).mockReturnValueOnce({ values: vi.fn(async () => undefined) });
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const eventBus = makeEventBus();
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, eventBus, makeLogger());

      await service.recalculate('ws_1', 'canon_1');

      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'customer_health.recalculated',
          workspaceId: 'ws_1',
          entityId: 'canon_1',
          payload: expect.objectContaining({ canonicalCustomerId: 'canon_1', score: null }),
        }),
      );
    });
  });

  describe('handleOrderCreated()', () => {
    function makeOrderCreatedEvent(overrides: Partial<DomainEvent<OrderCreatedPayload>> = {}): DomainEvent<OrderCreatedPayload> {
      return {
        id: 'evt_1',
        type: 'order.created',
        version: 1,
        workspaceId: 'ws_1',
        occurredAt: new Date().toISOString(),
        payload: { canonicalCustomerId: 'canon_1' },
        ...overrides,
      };
    }

    it('recalculates health for the event\'s workspace/canonical customer', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());
      const recalculateSpy = vi.spyOn(service, 'recalculate');

      await service.handleOrderCreated(makeOrderCreatedEvent());

      expect(recalculateSpy).toHaveBeenCalledWith('ws_1', 'canon_1');
    });

    it('does nothing when workspaceId is missing from the event envelope', async () => {
      const client = { insert: vi.fn() };
      const service = new CustomerHealthService(
        { client } as unknown as DatabaseService,
        {} as CustomerIntelligenceService,
        makeEventBus(),
        makeLogger(),
      );
      const recalculateSpy = vi.spyOn(service, 'recalculate');

      await service.handleOrderCreated(makeOrderCreatedEvent({ workspaceId: undefined }));

      expect(recalculateSpy).not.toHaveBeenCalled();
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('logs and does not rethrow when recalculate() fails — a failure here must never surface as a failure of the emitting webhook processor', async () => {
      const customerIntelligenceService = { getCustomer: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as CustomerIntelligenceService;
      const logger = makeLogger();
      const service = new CustomerHealthService({ client: {} } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), logger);

      await expect(service.handleOrderCreated(makeOrderCreatedEvent())).resolves.toBeUndefined();

      expect(logger.event).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('order.created'),
        'CustomerHealthService',
        expect.objectContaining({ canonicalCustomerId: 'canon_1' }),
      );
    });
  });

  describe('getCurrent()', () => {
    it('throws NotFoundError when no state has been calculated yet', async () => {
      const select = vi.fn(() => makeSelectChain([]));
      const client = { select };
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, {} as CustomerIntelligenceService, makeEventBus(), makeLogger());

      await expect(service.getCurrent('ws_1', 'canon_1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns the stored current state', async () => {
      const row = { workspaceId: 'ws_1', canonicalCustomerId: 'canon_1', score: null, healthCategory: null, signals: {}, reasonCodes: [], trend: null, lastCalculatedAt: new Date() };
      const select = vi.fn(() => makeSelectChain([row]));
      const client = { select };
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, {} as CustomerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.getCurrent('ws_1', 'canon_1');

      expect(result).toEqual(row);
    });
  });
});
