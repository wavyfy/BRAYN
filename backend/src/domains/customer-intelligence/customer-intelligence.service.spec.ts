import { describe, expect, it, vi } from 'vitest';
import { CustomerIntelligenceService } from './customer-intelligence.service';
import type { DatabaseService } from '../../database/database.service';

function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => result),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

function makeSelectQueue(results: unknown[]) {
  let i = 0;
  return vi.fn(() => makeChain(results[i++]));
}

describe('CustomerIntelligenceService', () => {
  describe('getCustomer()', () => {
    it('throws NotFoundError when no canonical customer exists in this workspace', async () => {
      const select = makeSelectQueue([[]]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      await expect(service.getCustomer('ws_1', 'canon_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('builds profile from source rows and lists source customers, with an empty commerce context when there are no linked orders', async () => {
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }], // canonical lookup
        [
          {
            id: 'cc_1',
            provider: 'shopify',
            externalId: '900',
            firstName: 'Ada',
            lastName: 'Lovelace',
            phone: '555-1234',
            sourceUpdatedAt: new Date('2026-01-02T00:00:00Z'),
          },
        ], // source rows
        [{ ordersCount: 0, totalSpent: '0', lastOrderAt: null }], // commerce summary
        [], // recent orders
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getCustomer('ws_1', 'canon_1');

      expect(result).toEqual({
        canonicalCustomerId: 'canon_1',
        profile: { email: 'a@example.com', firstName: 'Ada', lastName: 'Lovelace', phone: '555-1234' },
        sourceCustomers: [{ provider: 'shopify', externalId: '900' }],
        commerceContext: { ordersCount: 0, totalSpent: '0', lastOrderAt: null, recentOrders: [] },
      });
    });

    it('fills a profile field from whichever source row has it first, when the most-recent row is missing it', async () => {
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: null }],
        [
          // orderBy(desc(sourceUpdatedAt)) already applied server-side — this array simulates that order.
          { id: 'cc_1', provider: 'shopify', externalId: '900', firstName: null, lastName: 'Lovelace', phone: null, sourceUpdatedAt: new Date('2026-01-02T00:00:00Z') },
          { id: 'cc_2', provider: 'woocommerce', externalId: '5', firstName: 'Ada', lastName: null, phone: '555-1234', sourceUpdatedAt: new Date('2026-01-01T00:00:00Z') },
        ],
        [{ ordersCount: 0, totalSpent: '0', lastOrderAt: null }],
        [],
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getCustomer('ws_1', 'canon_1');

      expect(result.profile).toEqual({ email: null, firstName: 'Ada', lastName: 'Lovelace', phone: '555-1234' });
    });

    it('aggregates order count/total/last order date and lists recent orders', async () => {
      const lastOrderAt = new Date('2026-01-05T00:00:00Z');
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }],
        [{ id: 'cc_1', provider: 'shopify', externalId: '900', firstName: null, lastName: null, phone: null, sourceUpdatedAt: null }],
        [{ ordersCount: 3, totalSpent: '149.97', lastOrderAt }],
        [{ provider: 'shopify', externalId: '900', totalPrice: '19.99', createdAt: lastOrderAt }],
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getCustomer('ws_1', 'canon_1');

      expect(result.commerceContext).toEqual({
        ordersCount: 3,
        totalSpent: '149.97',
        lastOrderAt,
        recentOrders: [{ provider: 'shopify', externalId: '900', totalPrice: '19.99', createdAt: lastOrderAt }],
      });
    });
  });

  describe('getActivity()', () => {
    it('throws NotFoundError when no canonical customer exists in this workspace', async () => {
      const select = makeSelectQueue([[]]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      await expect(service.getActivity('ws_1', 'canon_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns a customer_created entry per source row when there are no orders', async () => {
      const createdAt = new Date('2026-01-01T00:00:00Z');
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }],
        [{ id: 'cc_1', provider: 'shopify', externalId: '900', firstName: null, lastName: null, phone: null, sourceUpdatedAt: null, createdAt }],
        [],
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getActivity('ws_1', 'canon_1');

      expect(result).toEqual([{ type: 'customer_created', occurredAt: createdAt, provider: 'shopify', externalId: '900' }]);
    });

    it('merges customer_created and order_placed entries, sorted newest first, timed by an order\'s sourceUpdatedAt over its createdAt', async () => {
      const customerCreatedAt = new Date('2026-01-01T00:00:00Z');
      const orderSourceUpdatedAt = new Date('2026-01-05T00:00:00Z');
      const orderCreatedAt = new Date('2026-01-03T00:00:00Z');
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }],
        [{ id: 'cc_1', provider: 'shopify', externalId: '900', firstName: null, lastName: null, phone: null, sourceUpdatedAt: null, createdAt: customerCreatedAt }],
        [{ provider: 'shopify', externalId: '9001', totalPrice: '19.99', sourceUpdatedAt: orderSourceUpdatedAt, createdAt: orderCreatedAt }],
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getActivity('ws_1', 'canon_1');

      expect(result).toEqual([
        { type: 'order_placed', occurredAt: orderSourceUpdatedAt, provider: 'shopify', externalId: '9001', totalPrice: '19.99' },
        { type: 'customer_created', occurredAt: customerCreatedAt, provider: 'shopify', externalId: '900' },
      ]);
    });

    it('falls back to an order\'s own createdAt when sourceUpdatedAt is null', async () => {
      const customerCreatedAt = new Date('2026-01-01T00:00:00Z');
      const orderCreatedAt = new Date('2026-01-02T00:00:00Z');
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }],
        [{ id: 'cc_1', provider: 'shopify', externalId: '900', firstName: null, lastName: null, phone: null, sourceUpdatedAt: null, createdAt: customerCreatedAt }],
        [{ provider: 'shopify', externalId: '9001', totalPrice: '19.99', sourceUpdatedAt: null, createdAt: orderCreatedAt }],
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getActivity('ws_1', 'canon_1');

      expect(result[0]).toMatchObject({ type: 'order_placed', occurredAt: orderCreatedAt });
    });

    it('skips the orders query entirely when there are no source rows', async () => {
      const select = makeSelectQueue([[{ id: 'canon_1', primaryEmail: null }], []]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getActivity('ws_1', 'canon_1');

      expect(result).toEqual([]);
      expect(select).toHaveBeenCalledTimes(2);
    });
  });
});
