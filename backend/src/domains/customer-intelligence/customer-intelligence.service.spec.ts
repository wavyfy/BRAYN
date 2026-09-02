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
});
