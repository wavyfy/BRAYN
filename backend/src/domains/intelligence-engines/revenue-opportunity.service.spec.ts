import { describe, expect, it, vi } from 'vitest';
import { RevenueOpportunityService, computePriority, isSuppressedByIgnored } from './revenue-opportunity.service';
import type { CustomerHealthService } from './customer-health.service';
import type { DatabaseService } from '../../database/database.service';
import type { EventBus } from '../../common/events/event-bus.service';
import type { CustomerIntelligenceService, CustomerRecord } from '../customer-intelligence/customer-intelligence.service';

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    groupBy: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

function makeSelectQueue(results: unknown[]) {
  let i = 0;
  return vi.fn(() => makeSelectChain(results[i++]));
}

function makeSelectDistinctQueue(results: unknown[]) {
  let i = 0;
  return vi.fn(() => makeSelectChain(results[i++]));
}

function makeInsertChain(returning: unknown[] = []) {
  return { values: vi.fn(() => ({ returning: vi.fn(async () => returning) })) };
}

function makeEventBus() {
  return { emit: vi.fn() } as unknown as EventBus;
}

/** `transaction(fn)` runs `fn` against the same mocked client, plus `execute` for the advisory lock. */
function makeDb(client: Record<string, unknown>) {
  const execute = vi.fn(async () => undefined);
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...client, execute }));
  return { client, transaction, execute } as unknown as DatabaseService & { execute: typeof execute };
}

function makeHealth(healthCategory: string | null = null) {
  return { findCurrent: vi.fn(async () => (healthCategory ? { healthCategory } : null)) } as unknown as CustomerHealthService;
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
      const select = makeSelectQueue([[], [], []]); // getIgnoredCommerceRows, getOpenTypes, then list()
      const client = { select, insert };
      const service = new RevenueOpportunityService(makeDb(client), makeCustomer({}), makeEventBus(), makeHealth());

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
      // [{count:0}] = getWorkspaceOrderCount (below the affinity floor, detectAffinityOpportunity bails);
      // [] = getSourceCustomerIds (detectUpsell's getPurchasedVariantsByRecency bails, no source customers);
      // [] = getOpenTypes; [] = list()
      const select = makeSelectQueue([[{ count: 0 }], [], [], []]);
      const client = { select, selectDistinct: makeSelectDistinctQueue([]), insert };
      const service = new RevenueOpportunityService(makeDb(client), customer, makeEventBus(), makeHealth());

      await service.detect('ws_1', 'canon_1');

      expect(insertChain.values).toHaveBeenCalledWith([expect.objectContaining({ type: 'reorder', status: 'new' })]);
    });

    it('does not detect a reorder opportunity with fewer than 2 orders', async () => {
      const customer = makeCustomer({ ordersCount: 1, lastOrderAt: new Date(), recentOrders: [{ provider: 'shopify', externalId: '1', totalPrice: '20', createdAt: new Date() }] });
      const insert = vi.fn();
      const select = makeSelectQueue([[{ count: 0 }], [], [], []]);
      const client = { select, selectDistinct: makeSelectDistinctQueue([]), insert };
      const service = new RevenueOpportunityService(makeDb(client), customer, makeEventBus(), makeHealth());

      await service.detect('ws_1', 'canon_1');

      expect(insert).not.toHaveBeenCalled();
    });

    it('detects a win_back opportunity once the customer has gone quiet past the threshold', async () => {
      const lastOrderAt = new Date(Date.now() - 150 * DAY_MS);
      const customer = makeCustomer({ ordersCount: 1, lastOrderAt, recentOrders: [{ provider: 'shopify', externalId: '1', totalPrice: '20', createdAt: lastOrderAt }] });
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const select = makeSelectQueue([[{ count: 0 }], [], [], []]);
      const client = { select, selectDistinct: makeSelectDistinctQueue([]), insert };
      const service = new RevenueOpportunityService(makeDb(client), customer, makeEventBus(), makeHealth());

      await service.detect('ws_1', 'canon_1');

      expect(insertChain.values).toHaveBeenCalledWith([expect.objectContaining({ type: 'win_back', status: 'new' })]);
    });

    it('detects a vip_recognition opportunity with no estimated revenue once the order-count threshold is reached', async () => {
      const customer = makeCustomer({ ordersCount: 10 });
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const select = makeSelectQueue([[{ count: 0 }], [], [], []]);
      const client = { select, selectDistinct: makeSelectDistinctQueue([]), insert };
      const service = new RevenueOpportunityService(makeDb(client), customer, makeEventBus(), makeHealth());

      await service.detect('ws_1', 'canon_1');

      expect(insertChain.values).toHaveBeenCalledWith([
        expect.objectContaining({ type: 'vip_recognition', status: 'new', estimatedRevenue: null, confidence: 100 }),
      ]);
    });

    it('skips a candidate whose type already has an open opportunity for this customer', async () => {
      const customer = makeCustomer({ ordersCount: 10 });
      const insert = vi.fn();
      const select = makeSelectQueue([[{ count: 0 }], [], [], [{ type: 'vip_recognition' }], []]); // no ignored rows, getOpenTypes already has it, then list()
      const client = { select, selectDistinct: makeSelectDistinctQueue([]), insert };
      const service = new RevenueOpportunityService(makeDb(client), customer, makeEventBus(), makeHealth());

      await service.detect('ws_1', 'canon_1');

      expect(insert).not.toHaveBeenCalled();
    });

    it('emits revenue_opportunity.created for each newly inserted opportunity', async () => {
      const customer = makeCustomer({ ordersCount: 10 });
      const createdRow = { id: 'opp_1', type: 'vip_recognition', priority: 'high', estimatedRevenue: null, confidence: 100 };
      const insert = vi.fn(() => makeInsertChain([createdRow]));
      const select = makeSelectQueue([[{ count: 0 }], [], [], []]);
      const client = { select, selectDistinct: makeSelectDistinctQueue([]), insert };
      const eventBus = makeEventBus();
      const service = new RevenueOpportunityService(makeDb(client), customer, eventBus, makeHealth());

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

    describe('cross_sell / bundle', () => {
      // Customer with exactly 1 order avoids accidentally tripping reorder (needs 2+), win_back (needs 120+ days quiet), and vip_recognition (needs 10+ orders).
      function makeAffinityCustomer() {
        return makeCustomer({ ordersCount: 1, lastOrderAt: new Date(), recentOrders: [{ provider: 'shopify', externalId: '1', totalPrice: '20', createdAt: new Date() }] });
      }

      /** Common tail every affinity test needs after its own affinity-specific entries: detectUpsell finding nothing, then getOpenTypes + list(). */
      const NO_UPSELL_NO_DUPLICATES_TAIL = [[], [], []]; // getSourceCustomerIds (upsell, empty) -> getOpenTypes -> list()

      it('detects cross_sell when the pair meets the count+ratio threshold but falls short of bundle\'s', async () => {
        const insertChain = makeInsertChain([{ id: 'opp_1', type: 'cross_sell', priority: 'medium', estimatedRevenue: '25.00', confidence: 30 }]);
        const insert = vi.fn(() => insertChain);
        const select = makeSelectQueue([
          [{ count: 25 }], // getWorkspaceOrderCount >= 20
          [{ id: 'sc_1' }], // getSourceCustomerIds (getPurchasedProductIds)
          [{ ownedProductId: 'prod_A', otherProductId: 'prod_B', coOccurringOrders: 3 }], // getProductAffinity — count 3 fails bundle's 5, passes cross-sell's 3
          [{ productId: 'prod_A', orderCount: 10 }], // getOwnedProductOrderCounts -> ratio 3/10 = 30%, fails bundle's 40%, passes cross-sell's 15%
          [{ price: '25.00' }], // getLowestVariantPrice(prod_B)
          ...NO_UPSELL_NO_DUPLICATES_TAIL,
        ]);
        const selectDistinct = makeSelectDistinctQueue([[{ productId: 'prod_A' }]]);
        const client = { select, selectDistinct, insert };
        const service = new RevenueOpportunityService(makeDb(client), makeAffinityCustomer(), makeEventBus(), makeHealth());

        await service.detect('ws_1', 'canon_1');

        expect(insertChain.values).toHaveBeenCalledWith([
          expect.objectContaining({ type: 'cross_sell', confidence: 30, estimatedRevenue: '25.00' }),
        ]);
      });

      it('does not fire when co-occurring order count is below the cross_sell floor', async () => {
        const insert = vi.fn();
        const select = makeSelectQueue([
          [{ count: 25 }],
          [{ id: 'sc_1' }],
          [{ ownedProductId: 'prod_A', otherProductId: 'prod_B', coOccurringOrders: 2 }], // below CROSS_SELL_MIN_CO_OCCURRING_ORDERS (3)
          [{ productId: 'prod_A', orderCount: 5 }], // ratio 2/5 = 40% — ratio alone would pass, count must not
          ...NO_UPSELL_NO_DUPLICATES_TAIL,
        ]);
        const selectDistinct = makeSelectDistinctQueue([[{ productId: 'prod_A' }]]);
        const client = { select, selectDistinct, insert };
        const service = new RevenueOpportunityService(makeDb(client), makeAffinityCustomer(), makeEventBus(), makeHealth());

        await service.detect('ws_1', 'canon_1');

        expect(insert).not.toHaveBeenCalled();
      });

      it('does not fire when the co-occurrence ratio is below the cross_sell floor', async () => {
        const insert = vi.fn();
        const select = makeSelectQueue([
          [{ count: 25 }],
          [{ id: 'sc_1' }],
          [{ ownedProductId: 'prod_A', otherProductId: 'prod_B', coOccurringOrders: 3 }], // count alone would pass
          [{ productId: 'prod_A', orderCount: 100 }], // ratio 3/100 = 3% — below CROSS_SELL_MIN_RATIO (15%)
          ...NO_UPSELL_NO_DUPLICATES_TAIL,
        ]);
        const selectDistinct = makeSelectDistinctQueue([[{ productId: 'prod_A' }]]);
        const client = { select, selectDistinct, insert };
        const service = new RevenueOpportunityService(makeDb(client), makeAffinityCustomer(), makeEventBus(), makeHealth());

        await service.detect('ws_1', 'canon_1');

        expect(insert).not.toHaveBeenCalled();
      });

      it('does not evaluate affinity at all when the workspace has fewer than 20 total orders', async () => {
        const insert = vi.fn();
        // Only 1 select expected before detectUpsell's own bail + getOpenTypes/list — detectAffinityOpportunity
        // must stop after getWorkspaceOrderCount and never touch getPurchasedProductIds/getProductAffinity.
        const select = makeSelectQueue([[{ count: 19 }], [], [], []]);
        const client = { select, selectDistinct: makeSelectDistinctQueue([]), insert };
        const service = new RevenueOpportunityService(makeDb(client), makeAffinityCustomer(), makeEventBus(), makeHealth());

        await service.detect('ws_1', 'canon_1');

        expect(insert).not.toHaveBeenCalled();
      });

      it('detects bundle when the pair meets bundle\'s stronger count+ratio threshold, not cross_sell', async () => {
        const insertChain = makeInsertChain([{ id: 'opp_1', type: 'bundle', priority: 'high', estimatedRevenue: '25.00', confidence: 60 }]);
        const insert = vi.fn(() => insertChain);
        const select = makeSelectQueue([
          [{ count: 25 }],
          [{ id: 'sc_1' }],
          [{ ownedProductId: 'prod_A', otherProductId: 'prod_B', coOccurringOrders: 6 }], // meets BUNDLE_MIN_CO_OCCURRING_ORDERS (5)
          [{ productId: 'prod_A', orderCount: 10 }], // ratio 6/10 = 60%, meets BUNDLE_MIN_RATIO (40%)
          [{ price: '10.00' }], // getLowestVariantPrice(prod_A, owned)
          [{ price: '15.00' }], // getLowestVariantPrice(prod_B, other) -> combined 25.00
          ...NO_UPSELL_NO_DUPLICATES_TAIL,
        ]);
        const selectDistinct = makeSelectDistinctQueue([[{ productId: 'prod_A' }]]);
        const client = { select, selectDistinct, insert };
        const service = new RevenueOpportunityService(makeDb(client), makeAffinityCustomer(), makeEventBus(), makeHealth());

        await service.detect('ws_1', 'canon_1');

        // Exactly one candidate inserted, type bundle — proves the pair did NOT also surface as cross_sell.
        expect(insertChain.values).toHaveBeenCalledWith([
          expect.objectContaining({ type: 'bundle', confidence: 60, estimatedRevenue: '25.00' }),
        ]);
      });

      it('skips a cross_sell candidate whose type already has an open opportunity for this customer', async () => {
        const insert = vi.fn();
        const select = makeSelectQueue([
          [{ count: 25 }],
          [{ id: 'sc_1' }],
          [{ ownedProductId: 'prod_A', otherProductId: 'prod_B', coOccurringOrders: 3 }],
          [{ productId: 'prod_A', orderCount: 10 }],
          [{ price: '25.00' }],
          [], // getSourceCustomerIds (upsell, empty)
          [], // getIgnoredCommerceRows
          [{ type: 'cross_sell' }], // getOpenTypes — already open
          [],
        ]);
        const selectDistinct = makeSelectDistinctQueue([[{ productId: 'prod_A' }]]);
        const client = { select, selectDistinct, insert };
        const service = new RevenueOpportunityService(makeDb(client), makeAffinityCustomer(), makeEventBus(), makeHealth());

        await service.detect('ws_1', 'canon_1');

        expect(insert).not.toHaveBeenCalled();
      });
    });

    describe('upsell', () => {
      function makeUpsellCustomer() {
        return makeCustomer({ ordersCount: 1, lastOrderAt: new Date(), recentOrders: [{ provider: 'shopify', externalId: '1', totalPrice: '20', createdAt: new Date() }] });
      }

      /** Every upsell test needs detectAffinityOpportunity to bail cleanly first (workspace below the affinity floor). */
      const AFFINITY_UNAVAILABLE = [{ count: 0 }];

      it('confidence 80 when exactly one higher-priced sibling variant exists', async () => {
        const insertChain = makeInsertChain([{ id: 'opp_1', type: 'upsell', priority: 'medium', estimatedRevenue: '8.00', confidence: 80 }]);
        const insert = vi.fn(() => insertChain);
        const purchasedAt = new Date('2026-01-01T00:00:00Z');
        const select = makeSelectQueue([
          AFFINITY_UNAVAILABLE,
          [{ id: 'sc_1' }], // getSourceCustomerIds (getPurchasedVariantsByRecency)
          [{ variantId: 'v1', productId: 'p1', price: '20.00', orderSourceUpdatedAt: purchasedAt, orderCreatedAt: purchasedAt }],
          [
            { id: 'v1', price: '20.00', inventoryQuantity: 5 }, // already purchased, excluded
            { id: 'v2', price: '28.00', inventoryQuantity: 5 }, // the one qualifying higher sibling
          ],
          [], // getOpenTypes
          [], // list()
        ]);
        const client = { select, selectDistinct: makeSelectDistinctQueue([]), insert };
        const service = new RevenueOpportunityService(makeDb(client), makeUpsellCustomer(), makeEventBus(), makeHealth());

        await service.detect('ws_1', 'canon_1');

        expect(insertChain.values).toHaveBeenCalledWith([
          expect.objectContaining({ type: 'upsell', confidence: 80, estimatedRevenue: '8.00' }),
        ]);
      });

      it('confidence 60 and nearest-tier selection when multiple higher-priced siblings exist', async () => {
        const insertChain = makeInsertChain([{ id: 'opp_1', type: 'upsell', priority: 'medium', estimatedRevenue: '5.00', confidence: 60 }]);
        const insert = vi.fn(() => insertChain);
        const purchasedAt = new Date('2026-01-01T00:00:00Z');
        const select = makeSelectQueue([
          AFFINITY_UNAVAILABLE,
          [{ id: 'sc_1' }],
          [{ variantId: 'v1', productId: 'p1', price: '20.00', orderSourceUpdatedAt: purchasedAt, orderCreatedAt: purchasedAt }],
          [
            { id: 'v1', price: '20.00', inventoryQuantity: 5 },
            { id: 'v2', price: '25.00', inventoryQuantity: 5 }, // nearest higher — must be chosen, not v3
            { id: 'v3', price: '30.00', inventoryQuantity: 5 },
          ],
          [],
          [],
        ]);
        const client = { select, selectDistinct: makeSelectDistinctQueue([]), insert };
        const service = new RevenueOpportunityService(makeDb(client), makeUpsellCustomer(), makeEventBus(), makeHealth());

        await service.detect('ws_1', 'canon_1');

        // delta to the nearest ($25) not the most expensive ($30) — $5.00, and confidence 60 since 2 higher candidates exist.
        expect(insertChain.values).toHaveBeenCalledWith([
          expect.objectContaining({ type: 'upsell', confidence: 60, estimatedRevenue: '5.00' }),
        ]);
      });

      it('does not fire when the customer already owns the highest-priced variant', async () => {
        const insert = vi.fn();
        const purchasedAt = new Date('2026-01-01T00:00:00Z');
        const select = makeSelectQueue([
          AFFINITY_UNAVAILABLE,
          [{ id: 'sc_1' }],
          [{ variantId: 'v1', productId: 'p1', price: '30.00', orderSourceUpdatedAt: purchasedAt, orderCreatedAt: purchasedAt }],
          [
            { id: 'v1', price: '30.00', inventoryQuantity: 5 }, // purchased, and already the highest
            { id: 'v2', price: '20.00', inventoryQuantity: 5 },
            { id: 'v3', price: '25.00', inventoryQuantity: 5 },
          ],
          [],
          [],
        ]);
        const client = { select, selectDistinct: makeSelectDistinctQueue([]), insert };
        const service = new RevenueOpportunityService(makeDb(client), makeUpsellCustomer(), makeEventBus(), makeHealth());

        await service.detect('ws_1', 'canon_1');

        expect(insert).not.toHaveBeenCalled();
      });

      it('treats null inventoryQuantity as available', async () => {
        const insertChain = makeInsertChain([{ id: 'opp_1', type: 'upsell', priority: 'medium', estimatedRevenue: '5.00', confidence: 80 }]);
        const insert = vi.fn(() => insertChain);
        const purchasedAt = new Date('2026-01-01T00:00:00Z');
        const select = makeSelectQueue([
          AFFINITY_UNAVAILABLE,
          [{ id: 'sc_1' }],
          [{ variantId: 'v1', productId: 'p1', price: '20.00', orderSourceUpdatedAt: purchasedAt, orderCreatedAt: purchasedAt }],
          [
            { id: 'v1', price: '20.00', inventoryQuantity: 5 },
            { id: 'v2', price: '25.00', inventoryQuantity: null }, // unknown inventory — must still qualify
          ],
          [],
          [],
        ]);
        const client = { select, selectDistinct: makeSelectDistinctQueue([]), insert };
        const service = new RevenueOpportunityService(makeDb(client), makeUpsellCustomer(), makeEventBus(), makeHealth());

        await service.detect('ws_1', 'canon_1');

        expect(insertChain.values).toHaveBeenCalledWith([
          expect.objectContaining({ type: 'upsell', confidence: 80, estimatedRevenue: '5.00' }),
        ]);
      });

      it('excludes an out-of-stock (inventoryQuantity = 0) candidate', async () => {
        const insert = vi.fn();
        const purchasedAt = new Date('2026-01-01T00:00:00Z');
        const select = makeSelectQueue([
          AFFINITY_UNAVAILABLE,
          [{ id: 'sc_1' }],
          [{ variantId: 'v1', productId: 'p1', price: '20.00', orderSourceUpdatedAt: purchasedAt, orderCreatedAt: purchasedAt }],
          [
            { id: 'v1', price: '20.00', inventoryQuantity: 5 },
            { id: 'v2', price: '25.00', inventoryQuantity: 0 }, // the only higher-priced sibling, but out of stock
          ],
          [],
          [],
        ]);
        const client = { select, selectDistinct: makeSelectDistinctQueue([]), insert };
        const service = new RevenueOpportunityService(makeDb(client), makeUpsellCustomer(), makeEventBus(), makeHealth());

        await service.detect('ws_1', 'canon_1');

        expect(insert).not.toHaveBeenCalled();
      });
    });
  });

  describe('list()', () => {
    it('returns whatever the query yields', async () => {
      const rows = [{ id: 'opp_1', type: 'vip_recognition', status: 'new' }];
      const select = vi.fn(() => makeSelectChain(rows));
      const client = { select };
      const service = new RevenueOpportunityService(makeDb(client), {} as CustomerIntelligenceService, makeEventBus(), makeHealth());

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
      const service = new RevenueOpportunityService(makeDb(client), {} as CustomerIntelligenceService, makeEventBus(), makeHealth());

      const result = await service.countOpenByWorkspace('ws_1');

      expect(result).toEqual({ total: 4, byPriority: { critical: 0, high: 3, medium: 0, low: 1 } });
    });
  });

  describe('computePriority() — health-aware adjustment (Milestone #5 Release 1)', () => {
    // confidence 75, no revenue factor: unadjusted = 75 → high; ×1.2 = 90 → critical; ×0.8 = 60 → medium.
    const priority = (type: Parameters<typeof computePriority>[3], health: string | null) => computePriority(75, null, null, type, health);

    it('Critical favors win-back and dampens pure upsell', () => {
      expect(priority('win_back', 'Critical')).toBe('critical');
      expect(priority('upsell', 'Critical')).toBe('medium');
    });

    it('At Risk favors win-back and leaves upsell unchanged', () => {
      expect(priority('win_back', 'At Risk')).toBe('critical');
      expect(priority('upsell', 'At Risk')).toBe('high');
    });

    it('Neutral adjusts nothing', () => {
      for (const type of ['win_back', 'upsell', 'cross_sell'] as const) expect(priority(type, 'Neutral')).toBe('high');
    });

    it('Healthy favors upsell/cross-sell and dampens win-back', () => {
      expect(priority('upsell', 'Healthy')).toBe('critical');
      expect(priority('cross_sell', 'Healthy')).toBe('critical');
      expect(priority('win_back', 'Healthy')).toBe('medium');
    });

    it('unknown health (no state / null score) adjusts nothing', () => {
      for (const type of ['win_back', 'upsell', 'cross_sell', 'reorder'] as const) expect(priority(type, null)).toBe('high');
    });

    it('leaves reorder, VIP and bundle unadjusted in every category', () => {
      for (const health of ['Critical', 'At Risk', 'Healthy'])
        for (const type of ['reorder', 'vip_recognition', 'bundle'] as const) expect(priority(type, health)).toBe('high');
    });

    it('stacks with — never replaces — the revenue/confidence factor', () => {
      // confidence 60, revenue 2× avg order (×1.2) = 72 → high; Healthy upsell ×1.2 = 86.4 → still high; Critical upsell ×0.8 = 57.6 → medium.
      expect(computePriority(60, '40.00', 20, 'upsell', null)).toBe('high');
      expect(computePriority(60, '40.00', 20, 'upsell', 'Healthy')).toBe('high');
      expect(computePriority(60, '40.00', 20, 'upsell', 'Critical')).toBe('medium');
    });
  });

  describe('detect() — health input and concurrency (Milestone #5 Release 1)', () => {
    const quietCustomer = () => {
      const lastOrderAt = new Date(Date.now() - 150 * DAY_MS);
      return makeCustomer({ ordersCount: 1, lastOrderAt, recentOrders: [{ provider: 'shopify', externalId: '1', totalPrice: '20', createdAt: lastOrderAt }] });
    };

    it("reads the customer's persisted health category into the priority", async () => {
      const prioritiesFor = async (health: string | null) => {
        const insertChain = makeInsertChain();
        const client = { select: makeSelectQueue([[{ count: 0 }], [], [], []]), selectDistinct: makeSelectDistinctQueue([]), insert: vi.fn(() => insertChain) };
        const healthService = makeHealth(health);
        await new RevenueOpportunityService(makeDb(client), quietCustomer(), makeEventBus(), healthService).detect('ws_1', 'canon_1');
        expect(healthService.findCurrent).toHaveBeenCalledWith('ws_1', 'canon_1');
        return (insertChain.values.mock.calls[0] as unknown as [{ priority: string }[]])[0][0].priority;
      };

      const unknown = await prioritiesFor(null);
      const healthy = await prioritiesFor('Healthy');
      const critical = await prioritiesFor('Critical');
      const order = ['low', 'medium', 'high', 'critical'];
      expect(order.indexOf(healthy)).toBeLessThanOrEqual(order.indexOf(unknown));
      expect(order.indexOf(critical)).toBeGreaterThanOrEqual(order.indexOf(unknown));
      expect(order.indexOf(critical)).toBeGreaterThan(order.indexOf(healthy));
    });

    it('takes a per-customer advisory lock inside the transaction before the open-type check and insert', async () => {
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const select = makeSelectQueue([[{ count: 0 }], [], [], []]);
      const db = makeDb({ select, selectDistinct: makeSelectDistinctQueue([]), insert });

      await new RevenueOpportunityService(db, quietCustomer(), makeEventBus(), makeHealth()).detect('ws_1', 'canon_1');

      expect(vi.mocked(db.transaction)).toHaveBeenCalledTimes(1);
      expect(db.execute).toHaveBeenCalledTimes(1);
      // getWorkspaceOrderCount, getSourceCustomerIds run outside; getOpenTypes (3rd select) and insert run after the lock.
      expect(db.execute.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[2]);
      expect(db.execute.mock.invocationCallOrder[0]).toBeLessThan(insert.mock.invocationCallOrder[0]);
    });
  });
});

describe('isSuppressedByIgnored() — #8 ignored recreation rule', () => {
  const dismissedAt = new Date('2026-10-01T00:00:00Z');
  const before = new Date('2026-09-01T00:00:00Z');
  const after = new Date('2026-10-15T00:00:00Z');
  const ignoredRow = (type: string, pair: [string | null, string | null] = [null, null]) => ({
    type: type as never,
    closedAt: dismissedAt,
    updatedAt: dismissedAt,
    affinityOwnedProductId: pair[0],
    affinityOtherProductId: pair[1],
  });
  const candidate = (type: string, extra: Record<string, unknown> = {}) =>
    ({ type, confidence: 50, estimatedRevenue: null, reason: 'r', recommendedAction: 'a', ...extra }) as never;

  it('never suppresses without an ignored row of the same type', () => {
    expect(isSuppressedByIgnored(candidate('reorder'), [ignoredRow('win_back')], before)).toBe(false);
  });

  it.each(['reorder', 'win_back'])('%s: suppressed until an order is placed after the dismissal', (type) => {
    expect(isSuppressedByIgnored(candidate(type), [ignoredRow(type)], before)).toBe(true);
    expect(isSuppressedByIgnored(candidate(type), [ignoredRow(type)], dismissedAt)).toBe(true);
    expect(isSuppressedByIgnored(candidate(type), [ignoredRow(type)], after)).toBe(false);
  });

  it('upsell: suppressed until its qualifying purchase is after the dismissal', () => {
    expect(isSuppressedByIgnored(candidate('upsell', { qualifyingPurchaseAt: before }), [ignoredRow('upsell')], after)).toBe(true);
    expect(isSuppressedByIgnored(candidate('upsell', { qualifyingPurchaseAt: after }), [ignoredRow('upsell')], after)).toBe(false);
  });

  it.each(['cross_sell', 'bundle'])('%s: same pair suppressed, different pair allowed, legacy row without a pair blocks', (type) => {
    const ab = candidate(type, { affinityOwnedProductId: 'A', affinityOtherProductId: 'B' });
    expect(isSuppressedByIgnored(ab, [ignoredRow(type, ['A', 'B'])], after)).toBe(true);
    expect(isSuppressedByIgnored(ab, [ignoredRow(type, ['A', 'C'])], after)).toBe(false);
    expect(isSuppressedByIgnored(ab, [ignoredRow(type, ['A', 'C']), ignoredRow(type, ['A', 'B'])], after)).toBe(true);
    expect(isSuppressedByIgnored(ab, [ignoredRow(type)], after)).toBe(true);
  });

  it('vip_recognition: always suppressed once ignored, even after new orders', () => {
    expect(isSuppressedByIgnored(candidate('vip_recognition'), [ignoredRow('vip_recognition')], after)).toBe(true);
  });
});
