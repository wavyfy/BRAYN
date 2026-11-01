import { describe, expect, it, vi } from 'vitest';
import { CustomerHealthService, categorize, computeTrend } from './customer-health.service';
import type { DatabaseService } from '../../database/database.service';
import type { DomainEvent } from '../../common/events/domain-event';
import type { EventBus } from '../../common/events/event-bus.service';
import type { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import type { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import type { OrderEventPayload } from '../commerce/commerce-events';

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
    it('withholds score/healthCategory only when there is no purchase history and no website activity', async () => {
      const stateInsert = makeInsertChain();
      const historyInsert = { values: vi.fn(async () => undefined) };
      const insert = vi.fn().mockReturnValueOnce(stateInsert).mockReturnValueOnce(historyInsert);
      const client = { insert, select: vi.fn(() => makeSelectChain([])) };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      expect(result.score).toBeNull();
      expect(result.healthCategory).toBeNull();
      expect(result.trend).toBe('unknown');
      expect(result.coverage).toEqual({ availableWeight: 65, totalWeight: 100 });
      expect(result.reasonCodes.at(-1)).toContain('withheld');
    });

    it('computes a recency score of 0 and a reason code when there are no orders on record', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert, select: vi.fn(() => makeSelectChain([])) };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      expect(result.signals).toMatchObject({ purchaseRecency: { available: true, value: null, score: 0 } });
      expect(result.reasonCodes[0]).toContain('No orders on record');
    });

    it('computes a decayed recency score based on days since the last order', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert, select: vi.fn(() => makeSelectChain([])) };
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
      const client = { insert, select: vi.fn(() => makeSelectChain([])) };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: new Date(), ordersLast90Days: 10 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      const frequency = (result.signals as Record<string, { value: number; score: number }>).purchaseFrequency;
      expect(frequency.value).toBe(10);
      expect(frequency.score).toBe(100);
    });

    it('marks WhatsApp/email/customer-experience signals unavailable, each with a reason', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert, select: vi.fn(() => makeSelectChain([])) };
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
      const client = { insert, select: vi.fn(() => makeSelectChain([])) };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      const signals = result.signals as Record<string, { available: boolean; value: number; score: number }>;
      expect(signals.websiteEngagement).toMatchObject({ available: true, value: 0, score: 0 });
      expect(result.reasonCodes).toContainEqual(expect.stringContaining('No website activity recorded'));
    });

    it('computes a blended recency/frequency website engagement score when behavioural data exists', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert, select: vi.fn(() => makeSelectChain([])) };
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
      const client = { insert, select: vi.fn(() => makeSelectChain([])) };
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

    it('caps the website recency sub-score at 100 when lastActivityAt is slightly in the future (client clock skew)', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const customerIntelligenceService = makeCustomerIntelligenceService(
        { lastOrderAt: null, ordersLast90Days: 0 },
        { eventsCount: 500, lastActivityAt: new Date(Date.now() + 4 * 60 * 1000) },
      );
      const service = new CustomerHealthService({ client: { insert, select: vi.fn(() => makeSelectChain([])) } } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      const result = await service.recalculate('ws_1', 'canon_1');

      const website = (result.signals as Record<string, { value: number; score: number }>).websiteEngagement;
      expect(website.score).toBe(100);
    });

    it('scopes the website engagement signal to the requested workspace via getCustomer', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert, select: vi.fn(() => makeSelectChain([])) };
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
      const client = { insert, select: vi.fn(() => makeSelectChain([])) };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());

      await service.recalculate('ws_1', 'canon_1');

      expect(stateInsert.values).toHaveBeenCalledTimes(1);
      expect(stateInsert.onConflictDoUpdate).toHaveBeenCalledTimes(1);
      expect(historyInsert.values).toHaveBeenCalledTimes(1);
    });

    it('emits customer_health.recalculated after every recalculation', async () => {
      const insert = vi.fn().mockReturnValueOnce(makeInsertChain()).mockReturnValueOnce({ values: vi.fn(async () => undefined) });
      const client = { insert, select: vi.fn(() => makeSelectChain([])) };
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

  describe('handleCommerceEvent()', () => {
    function makeOrderCreatedEvent(overrides: Partial<DomainEvent<OrderEventPayload>> = {}): DomainEvent<OrderEventPayload> {
      return {
        id: 'evt_1',
        type: 'order.created',
        version: 1,
        workspaceId: 'ws_1',
        occurredAt: new Date().toISOString(),
        payload: { orderId: 'order_1', orderExternalId: '900', provider: 'shopify', canonicalCustomerId: 'canon_1', sourceOccurredAt: null },
        ...overrides,
      };
    }

    it('recalculates health for the event\'s workspace/canonical customer', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert, select: vi.fn(() => makeSelectChain([])) };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());
      const recalculateSpy = vi.spyOn(service, 'recalculate');

      await service.handleCommerceEvent(makeOrderCreatedEvent());

      expect(recalculateSpy).toHaveBeenCalledWith('ws_1', 'canon_1');
    });

    it.each(['order.cancelled', 'refund.processed'])('recalculates on %s exactly like order.created', async (type) => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client: { insert, select: vi.fn(() => makeSelectChain([])) } } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), makeLogger());
      const recalculateSpy = vi.spyOn(service, 'recalculate');

      await service.handleCommerceEvent(makeOrderCreatedEvent({ type }));

      expect(recalculateSpy).toHaveBeenCalledWith('ws_1', 'canon_1');
    });

    it('skips an event whose customer is not identity-resolved (or a guest checkout)', async () => {
      const client = { insert: vi.fn() };
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, {} as CustomerIntelligenceService, makeEventBus(), makeLogger());
      const recalculateSpy = vi.spyOn(service, 'recalculate');
      const event = makeOrderCreatedEvent();

      await service.handleCommerceEvent({ ...event, payload: { ...event.payload, canonicalCustomerId: null } });

      expect(recalculateSpy).not.toHaveBeenCalled();
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

      await service.handleCommerceEvent(makeOrderCreatedEvent({ workspaceId: undefined }));

      expect(recalculateSpy).not.toHaveBeenCalled();
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('logs and does not rethrow when recalculate() fails — a failure here must never surface as a failure of the emitting webhook processor', async () => {
      const customerIntelligenceService = { getCustomer: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as CustomerIntelligenceService;
      const logger = makeLogger();
      const service = new CustomerHealthService({ client: {} } as unknown as DatabaseService, customerIntelligenceService, makeEventBus(), logger);

      await expect(service.handleCommerceEvent(makeOrderCreatedEvent())).resolves.toBeUndefined();

      expect(logger.event).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('order.created'),
        'CustomerHealthService',
        expect.objectContaining({ canonicalCustomerId: 'canon_1' }),
      );
    });
  });

  describe('recalculate() — Milestone #5 D1 scoring', () => {
    function makeService(
      commerce: { lastOrderAt: Date | null; ordersLast90Days: number; ordersCount?: number },
      behaviour?: { eventsCount: number; lastActivityAt: Date | null },
      previousRow: Record<string, unknown> | null = null,
    ) {
      const stateInsert = makeInsertChain();
      const historyInsert = { values: vi.fn(async () => undefined) };
      const client = {
        insert: vi.fn().mockReturnValueOnce(stateInsert).mockReturnValueOnce(historyInsert),
        select: vi.fn(() => makeSelectChain(previousRow ? [previousRow] : [])),
      };
      const eventBus = makeEventBus();
      const service = new CustomerHealthService(
        { client } as unknown as DatabaseService,
        makeCustomerIntelligenceService(commerce as { lastOrderAt: Date | null; ordersLast90Days: number }, behaviour),
        eventBus,
        makeLogger(),
      );
      return { service, stateInsert, historyInsert, eventBus };
    }
    const DAY = 24 * 60 * 60 * 1000;

    it('rescales the available signals to 100% and excludes unavailable ones (not counted as 0)', async () => {
      // recency: 0 days → 100 (w30); frequency: 4 orders → 100 (w20); website: none → 0 (w15).
      // Rescaled: (100·30 + 100·20 + 0·15) / 65 = 76.9 → 77. Counting the 35% unavailable weight as 0 would give 50.
      const { service } = makeService({ lastOrderAt: new Date(), ordersLast90Days: 4, ordersCount: 4 });

      const result = await service.recalculate('ws_1', 'canon_1');

      expect(result.score).toBe(77);
      expect(result.healthCategory).toBe('Healthy');
      expect(result.coverage).toEqual({ availableWeight: 65, totalWeight: 100 });
      expect(result.reasonCodes.at(-1)).toContain('rescaled to 100%');
    });

    it('scores a customer with website activity but no purchases (purchase signals count as 0, score not null)', async () => {
      // website: recency 100·0.6 + frequency (20/20) 100·0.4 = 100 (w15); purchases 0 → 100·15/65 = 23.
      const { service } = makeService({ lastOrderAt: null, ordersLast90Days: 0 }, { eventsCount: 20, lastActivityAt: new Date() });

      const result = await service.recalculate('ws_1', 'canon_1');

      expect(result.score).toBe(23);
      expect(result.healthCategory).toBe('Critical');
    });

    it('persists the score, category and trend on the current state and the history row', async () => {
      const { service, stateInsert, historyInsert } = makeService({ lastOrderAt: new Date(), ordersLast90Days: 4, ordersCount: 4 });

      await service.recalculate('ws_1', 'canon_1');

      const written = expect.objectContaining({ score: 77, healthCategory: 'Healthy', trend: 'unknown' });
      expect(stateInsert.values).toHaveBeenCalledWith(written);
      expect(historyInsert.values).toHaveBeenCalledWith(written);
      expect(vi.mocked(stateInsert.values as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('coverage');
    });

    it('trends against the previously persisted score', async () => {
      const current = { lastOrderAt: new Date(), ordersLast90Days: 4, ordersCount: 4 }; // → 77
      const trendFor = async (previousScore: number | null) =>
        (await makeService(current, undefined, { score: previousScore, signals: {} }).service.recalculate('ws_1', 'canon_1')).trend;

      expect(await trendFor(71)).toBe('improving'); // +6
      expect(await trendFor(72)).toBe('stable'); // +5
      expect(await trendFor(82)).toBe('stable'); // -5
      expect(await trendFor(83)).toBe('declining'); // -6
      expect(await trendFor(null)).toBe('unknown');
    });

    it('scores a customer quiet for 60 days with one recent-window order as Critical', async () => {
      // recency: 60/90 → 33 (w30); frequency 1/4 → 25 (w20); website 0 → (33·30 + 25·20) / 65 = 22.9 → 23 → Critical.
      const { service } = makeService({ lastOrderAt: new Date(Date.now() - 60 * DAY), ordersLast90Days: 1, ordersCount: 1 });

      expect((await service.recalculate('ws_1', 'canon_1')).healthCategory).toBe('Critical');
    });

    describe('emitOnlyOnChange (daily run, Milestone #5 Release 2)', () => {
      const current = { lastOrderAt: new Date(), ordersLast90Days: 4, ordersCount: 4 }; // → 77, Healthy, stable vs 77

      it('persists but does not emit when score, category and trend are unchanged', async () => {
        const { service, historyInsert, eventBus } = makeService(current, undefined, { score: 77, healthCategory: 'Healthy', trend: 'stable', signals: {} });

        await service.recalculate('ws_1', 'canon_1', { emitOnlyOnChange: true });

        expect(historyInsert.values).toHaveBeenCalled();
        expect(eventBus.emit).not.toHaveBeenCalled();
      });

      it('emits when the trend changed even though score and category did not', async () => {
        const { service, eventBus } = makeService(current, undefined, { score: 77, healthCategory: 'Healthy', trend: 'improving', signals: {} });

        await service.recalculate('ws_1', 'canon_1', { emitOnlyOnChange: true });

        expect(eventBus.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'customer_health.recalculated' }));
      });

      it('emits on a first-ever calculation (no previous state)', async () => {
        const { service, eventBus } = makeService(current);

        await service.recalculate('ws_1', 'canon_1', { emitOnlyOnChange: true });

        expect(eventBus.emit).toHaveBeenCalledTimes(1);
      });

      it('still emits an unchanged recalculation without the option (Release 1 event-driven/manual behaviour unchanged)', async () => {
        const { service, eventBus } = makeService(current, undefined, { score: 77, healthCategory: 'Healthy', trend: 'stable', signals: {} });

        await service.recalculate('ws_1', 'canon_1');

        expect(eventBus.emit).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('categorize() / computeTrend()', () => {
    it('maps the D1 category boundaries', () => {
      const cases: [number, string][] = [[0, 'Critical'], [24, 'Critical'], [25, 'At Risk'], [49, 'At Risk'], [50, 'Neutral'], [74, 'Neutral'], [75, 'Healthy'], [100, 'Healthy']];
      for (const [score, category] of cases) expect(categorize(score)).toBe(category);
    });

    it('uses a strict ±5 threshold and unknown when either score is missing', () => {
      expect(computeTrend(56, 50)).toBe('improving');
      expect(computeTrend(55, 50)).toBe('stable');
      expect(computeTrend(45, 50)).toBe('stable');
      expect(computeTrend(44, 50)).toBe('declining');
      expect(computeTrend(50, null)).toBe('unknown');
      expect(computeTrend(null, 50)).toBe('unknown');
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

      expect(result).toEqual({ ...row, coverage: { availableWeight: 0, totalWeight: 0 } });
    });
  });
});
