import { describe, expect, it, vi } from 'vitest';
import { CustomerHealthService } from './customer-health.service';
import type { DatabaseService } from '../../database/database.service';
import type { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';

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

function makeCustomerIntelligenceService(commerceContext: { lastOrderAt: Date | null; ordersLast90Days: number }): CustomerIntelligenceService {
  return {
    getCustomer: vi.fn(async () => ({
      canonicalCustomerId: 'canon_1',
      profile: { email: null, firstName: null, lastName: null, phone: null },
      sourceCustomers: [],
      commerceContext: { ordersCount: 0, totalSpent: '0', recentOrders: [], ...commerceContext },
    })),
  } as unknown as CustomerIntelligenceService;
}

describe('CustomerHealthService', () => {
  describe('recalculate()', () => {
    it('withholds score/healthCategory/trend — only 50% of the signal weight is available', async () => {
      const stateInsert = makeInsertChain();
      const historyInsert = { values: vi.fn(async () => undefined) };
      const insert = vi.fn().mockReturnValueOnce(stateInsert).mockReturnValueOnce(historyInsert);
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService);

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
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService);

      const result = await service.recalculate('ws_1', 'canon_1');

      expect(result.signals).toMatchObject({ purchaseRecency: { available: true, value: null, score: 0 } });
      expect(result.reasonCodes[0]).toContain('No orders on record');
    });

    it('computes a decayed recency score based on days since the last order', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert };
      const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: fortyFiveDaysAgo, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService);

      const result = await service.recalculate('ws_1', 'canon_1');

      const recency = (result.signals as Record<string, { value: number; score: number }>).purchaseRecency;
      expect(recency.value).toBe(45);
      expect(recency.score).toBe(50); // halfway through the 90-day decay window
    });

    it('caps the frequency score at 100 once orders reach the target threshold', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: new Date(), ordersLast90Days: 10 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService);

      const result = await service.recalculate('ws_1', 'canon_1');

      const frequency = (result.signals as Record<string, { value: number; score: number }>).purchaseFrequency;
      expect(frequency.value).toBe(10);
      expect(frequency.score).toBe(100);
    });

    it('marks website/WhatsApp/email/customer-experience signals unavailable, each with a reason', async () => {
      const insert = vi.fn().mockReturnValue(makeInsertChain());
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService);

      const result = await service.recalculate('ws_1', 'canon_1');

      const signals = result.signals as Record<string, { available: boolean; reason?: string }>;
      expect(signals.websiteEngagement).toMatchObject({ available: false });
      expect(signals.whatsappEngagement).toMatchObject({ available: false });
      expect(signals.emailEngagement).toMatchObject({ available: false });
      expect(signals.customerExperience).toMatchObject({ available: false });
      expect(signals.emailEngagement.reason).toContain('product decision');
    });

    it('writes both the current state (upsert) and a history row', async () => {
      const stateInsert = makeInsertChain();
      const historyInsert = { values: vi.fn(async () => undefined) };
      const insert = vi.fn().mockReturnValueOnce(stateInsert).mockReturnValueOnce(historyInsert);
      const client = { insert };
      const customerIntelligenceService = makeCustomerIntelligenceService({ lastOrderAt: null, ordersLast90Days: 0 });
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, customerIntelligenceService);

      await service.recalculate('ws_1', 'canon_1');

      expect(stateInsert.values).toHaveBeenCalledTimes(1);
      expect(stateInsert.onConflictDoUpdate).toHaveBeenCalledTimes(1);
      expect(historyInsert.values).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCurrent()', () => {
    it('throws NotFoundError when no state has been calculated yet', async () => {
      const select = vi.fn(() => makeSelectChain([]));
      const client = { select };
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, {} as CustomerIntelligenceService);

      await expect(service.getCurrent('ws_1', 'canon_1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns the stored current state', async () => {
      const row = { workspaceId: 'ws_1', canonicalCustomerId: 'canon_1', score: null, healthCategory: null, signals: {}, reasonCodes: [], trend: null, lastCalculatedAt: new Date() };
      const select = vi.fn(() => makeSelectChain([row]));
      const client = { select };
      const service = new CustomerHealthService({ client } as unknown as DatabaseService, {} as CustomerIntelligenceService);

      const result = await service.getCurrent('ws_1', 'canon_1');

      expect(result).toEqual(row);
    });
  });
});
