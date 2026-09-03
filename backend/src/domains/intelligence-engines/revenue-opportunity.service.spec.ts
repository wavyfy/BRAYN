import { describe, expect, it, vi } from 'vitest';
import { RevenueOpportunityService } from './revenue-opportunity.service';
import type { DatabaseService } from '../../database/database.service';
import type { EventBus } from '../../common/events/event-bus.service';
import type { CustomerIntelligenceService, CustomerRecord } from '../customer-intelligence/customer-intelligence.service';

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

function makeSelectQueue(results: unknown[]) {
  let i = 0;
  return vi.fn(() => makeSelectChain(results[i++]));
}

function makeInsertChain(returning: unknown[] = []) {
  return { values: vi.fn(() => ({ returning: vi.fn(async () => returning) })) };
}

function makeEventBus() {
  return { emit: vi.fn() } as unknown as EventBus;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function makeCustomer(commerceContext: Partial<CustomerRecord['commerceContext']>): CustomerIntelligenceService {
  return {
    getCustomer: vi.fn(async () => ({
      canonicalCustomerId: 'canon_1',
      profile: { email: null, firstName: null, lastName: null, phone: null },
      sourceCustomers: [],
      commerceContext: { ordersCount: 0, totalSpent: '0', lastOrderAt: null, ordersLast90Days: 0, recentOrders: [], ...commerceContext },
    })),
  } as unknown as CustomerIntelligenceService;
}

describe('RevenueOpportunityService', () => {
  describe('detect()', () => {
    it('creates no candidates for a customer with no orders', async () => {
      const insert = vi.fn();
      const select = makeSelectQueue([[], []]); // getOpenTypes, then list()
      const client = { select, insert };
      const service = new RevenueOpportunityService({ client } as unknown as DatabaseService, makeCustomer({}), makeEventBus());

      const result = await service.detect('ws_1', 'canon_1');

      expect(insert).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('detects a reorder opportunity when time since the last order has caught up to the customer\'s own average gap', async () => {
      const now = Date.now();
      const recentOrders = [
        { provider: 'shopify', externalId: '3', totalPrice: '20.00', createdAt: new Date(now - 20 * DAY_MS) },
        { provider: 'shopify', externalId: '2', totalPrice: '20.00', createdAt: new Date(now - 30 * DAY_MS) },
        { provider: 'shopify', externalId: '1', totalPrice: '20.00', createdAt: new Date(now - 40 * DAY_MS) },
      ];
      const customer = makeCustomer({
        ordersCount: 3,
        totalSpent: '60.00',
        lastOrderAt: recentOrders[0].createdAt,
        recentOrders,
      });
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const select = makeSelectQueue([[], []]);
      const client = { select, insert };
      const service = new RevenueOpportunityService({ client } as unknown as DatabaseService, customer, makeEventBus());

      await service.detect('ws_1', 'canon_1');

      expect(insertChain.values).toHaveBeenCalledWith([expect.objectContaining({ type: 'reorder', status: 'new' })]);
    });

    it('does not detect a reorder opportunity with fewer than 2 orders', async () => {
      const customer = makeCustomer({ ordersCount: 1, lastOrderAt: new Date(), recentOrders: [{ provider: 'shopify', externalId: '1', totalPrice: '20', createdAt: new Date() }] });
      const insert = vi.fn();
      const select = makeSelectQueue([[], []]);
      const client = { select, insert };
      const service = new RevenueOpportunityService({ client } as unknown as DatabaseService, customer, makeEventBus());

      await service.detect('ws_1', 'canon_1');

      expect(insert).not.toHaveBeenCalled();
    });

    it('detects a win_back opportunity once the customer has gone quiet past the threshold', async () => {
      const lastOrderAt = new Date(Date.now() - 150 * DAY_MS);
      const customer = makeCustomer({ ordersCount: 1, lastOrderAt, recentOrders: [{ provider: 'shopify', externalId: '1', totalPrice: '20', createdAt: lastOrderAt }] });
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const select = makeSelectQueue([[], []]);
      const client = { select, insert };
      const service = new RevenueOpportunityService({ client } as unknown as DatabaseService, customer, makeEventBus());

      await service.detect('ws_1', 'canon_1');

      expect(insertChain.values).toHaveBeenCalledWith([expect.objectContaining({ type: 'win_back', status: 'new' })]);
    });

    it('detects a vip_recognition opportunity with no estimated revenue once the order-count threshold is reached', async () => {
      const customer = makeCustomer({ ordersCount: 10 });
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const select = makeSelectQueue([[], []]);
      const client = { select, insert };
      const service = new RevenueOpportunityService({ client } as unknown as DatabaseService, customer, makeEventBus());

      await service.detect('ws_1', 'canon_1');

      expect(insertChain.values).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'vip_recognition', status: 'new', estimatedRevenue: null, confidence: 100 }),
      ]);
    });

    it('skips a candidate whose type already has an open opportunity for this customer', async () => {
      const customer = makeCustomer({ ordersCount: 10 });
      const insert = vi.fn();
      const select = makeSelectQueue([[{ type: 'vip_recognition' }], []]); // getOpenTypes already has it, then list()
      const client = { select, insert };
      const service = new RevenueOpportunityService({ client } as unknown as DatabaseService, customer, makeEventBus());

      await service.detect('ws_1', 'canon_1');

      expect(insert).not.toHaveBeenCalled();
    });

    it('emits revenue_opportunity.created for each newly inserted opportunity', async () => {
      const customer = makeCustomer({ ordersCount: 10 });
      const createdRow = { id: 'opp_1', type: 'vip_recognition', priority: 'high', estimatedRevenue: null, confidence: 100 };
      const insert = vi.fn(() => makeInsertChain([createdRow]));
      const select = makeSelectQueue([[], []]);
      const client = { select, insert };
      const eventBus = makeEventBus();
      const service = new RevenueOpportunityService({ client } as unknown as DatabaseService, customer, eventBus);

      await service.detect('ws_1', 'canon_1');

      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'revenue_opportunity.created',
          workspaceId: 'ws_1',
          entityId: 'opp_1',
          payload: expect.objectContaining({ opportunityId: 'opp_1', canonicalCustomerId: 'canon_1', type: 'vip_recognition' }),
        }),
      );
    });
  });

  describe('list()', () => {
    it('returns whatever the query yields', async () => {
      const rows = [{ id: 'opp_1', type: 'vip_recognition', status: 'new' }];
      const select = vi.fn(() => makeSelectChain(rows));
      const client = { select };
      const service = new RevenueOpportunityService({ client } as unknown as DatabaseService, {} as CustomerIntelligenceService, makeEventBus());

      const result = await service.list('ws_1', 'canon_1');

      expect(result).toEqual(rows);
    });
  });

  describe('countOpenByWorkspace()', () => {
    it('groups open opportunity counts by priority, defaulting missing priorities to zero', async () => {
      const rows = [{ priority: 'high', count: 3 }, { priority: 'low', count: 1 }];
      const select = vi.fn(() => {
        const chain: Record<string, unknown> = {
          from: vi.fn(() => chain),
          where: vi.fn(() => chain),
          groupBy: vi.fn(async () => rows),
        };
        return chain;
      });
      const client = { select };
      const service = new RevenueOpportunityService({ client } as unknown as DatabaseService, {} as CustomerIntelligenceService, makeEventBus());

      const result = await service.countOpenByWorkspace('ws_1');

      expect(result).toEqual({ total: 4, byPriority: { critical: 0, high: 3, medium: 0, low: 1 } });
    });
  });
});
