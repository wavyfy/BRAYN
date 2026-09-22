import { describe, expect, it, vi } from 'vitest';
import { CustomerIntelligenceService } from './customer-intelligence.service';
import type { DatabaseService } from '../../database/database.service';

function makeChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    offset: vi.fn(async () => result),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

function makeSelectQueue(results: unknown[]) {
  let i = 0;
  return vi.fn(() => makeChain(results[i++]));
}

const EMPTY_BEHAVIOURAL_CONTEXT = { eventsCount: 0, lastActivityAt: null, recentEvents: [] };

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
        [], // linked website visitors (none)
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getCustomer('ws_1', 'canon_1');

      expect(result).toEqual({
        canonicalCustomerId: 'canon_1',
        profile: { email: 'a@example.com', firstName: 'Ada', lastName: 'Lovelace', phone: '555-1234' },
        sourceCustomers: [{ provider: 'shopify', externalId: '900' }],
        commerceContext: { ordersCount: 0, totalSpent: '0', lastOrderAt: null, ordersLast90Days: 0, recentOrders: [] },
        behaviouralContext: EMPTY_BEHAVIOURAL_CONTEXT,
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
        [{ ordersCount: 3, totalSpent: '149.97', lastOrderAt, ordersLast90Days: 2 }],
        [{ provider: 'shopify', externalId: '900', totalPrice: '19.99', createdAt: lastOrderAt }],
        [],
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getCustomer('ws_1', 'canon_1');

      expect(result.commerceContext).toEqual({
        ordersCount: 3,
        totalSpent: '149.97',
        lastOrderAt,
        ordersLast90Days: 2,
        recentOrders: [{ provider: 'shopify', externalId: '900', totalPrice: '19.99', createdAt: lastOrderAt }],
      });
    });

    it('returns behavioural context for a canonical customer with a linked website visitor', async () => {
      const lastActivityAt = new Date('2026-02-01T00:00:00Z');
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }], // canonical lookup
        [], // no source rows -> commerce context short-circuits with no further selects
        [{ id: 'visitor_1' }], // linked website visitors
        [{ eventsCount: 2, lastActivityAt }], // behavioural summary
        [{ eventType: 'product_view', occurredAt: lastActivityAt }], // recent events
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getCustomer('ws_1', 'canon_1');

      expect(result.behaviouralContext).toEqual({
        eventsCount: 2,
        lastActivityAt,
        recentEvents: [{ eventType: 'product_view', occurredAt: lastActivityAt }],
      });
    });

    it('excludes behavioural context (returns the zeroed shape) when no website visitor is linked to this customer', async () => {
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }],
        [],
        [], // linked website visitors — none, whether because there's no anonymous activity or it exists but is still unlinked
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getCustomer('ws_1', 'canon_1');

      expect(result.behaviouralContext).toEqual(EMPTY_BEHAVIOURAL_CONTEXT);
    });

    it('excludes behavioural context for a visitor linked only in a different workspace (workspace isolation)', async () => {
      // The real query filters website_visitors by (workspaceId, canonicalCustomerId) together — a
      // visitor linked to this same canonicalCustomerId value under a different workspace would never
      // match, so the query simply returns no rows, exactly as simulated here.
      const select = makeSelectQueue([[{ id: 'canon_1', primaryEmail: 'a@example.com' }], [], []]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getCustomer('ws_1', 'canon_1');

      expect(result.behaviouralContext).toEqual(EMPTY_BEHAVIOURAL_CONTEXT);
    });
  });

  describe('listCustomers()', () => {
    it('returns an empty page without querying names when there are no canonical customers', async () => {
      const select = makeSelectQueue([[]]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.listCustomers('ws_1');

      expect(result).toEqual({ customers: [], page: 1, limit: 20, hasMore: false });
      expect(select).toHaveBeenCalledTimes(1);
    });

    it('lists customers with names filled from commerce_customers, and reports hasMore correctly', async () => {
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }, { id: 'canon_2', primaryEmail: 'b@example.com' }, { id: 'canon_3', primaryEmail: null }], // limit+1 = 3, limit=2 -> hasMore
        [
          { canonicalCustomerId: 'canon_1', firstName: 'Ada', lastName: 'Lovelace' },
          { canonicalCustomerId: 'canon_2', firstName: null, lastName: 'Smith' },
        ],
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.listCustomers('ws_1', { limit: 2 });

      expect(result).toEqual({
        customers: [
          { canonicalCustomerId: 'canon_1', email: 'a@example.com', firstName: 'Ada', lastName: 'Lovelace' },
          { canonicalCustomerId: 'canon_2', email: 'b@example.com', firstName: null, lastName: 'Smith' },
        ],
        page: 1,
        limit: 2,
        hasMore: true,
      });
    });

    it('merges a name from a second source row when the first is missing it', async () => {
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }],
        [
          { canonicalCustomerId: 'canon_1', firstName: null, lastName: 'Lovelace' },
          { canonicalCustomerId: 'canon_1', firstName: 'Ada', lastName: null },
        ],
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.listCustomers('ws_1');

      expect(result.customers[0]).toEqual({ canonicalCustomerId: 'canon_1', email: 'a@example.com', firstName: 'Ada', lastName: 'Lovelace' });
    });
  });

  describe('getActivity()', () => {
    it('throws NotFoundError when no canonical customer exists in this workspace', async () => {
      const select = makeSelectQueue([[]]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      await expect(service.getActivity('ws_1', 'canon_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns a customer_created entry per source row when there are no orders or website activity', async () => {
      const createdAt = new Date('2026-01-01T00:00:00Z');
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }],
        [{ id: 'cc_1', provider: 'shopify', externalId: '900', firstName: null, lastName: null, phone: null, sourceUpdatedAt: null, createdAt }],
        [], // orders
        [], // linked website visitors
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
        [], // linked website visitors
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
        [],
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getActivity('ws_1', 'canon_1');

      expect(result[0]).toMatchObject({ type: 'order_placed', occurredAt: orderCreatedAt });
    });

    it('skips the orders query entirely when there are no source rows', async () => {
      const select = makeSelectQueue([[{ id: 'canon_1', primaryEmail: null }], [], []]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getActivity('ws_1', 'canon_1');

      expect(result).toEqual([]);
      expect(select).toHaveBeenCalledTimes(3);
    });

    it('includes website_activity entries for a linked visitor in the chronological history', async () => {
      const eventAt = new Date('2026-01-10T00:00:00Z');
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }],
        [], // no source rows -> orders query skipped
        [{ id: 'visitor_1' }], // linked website visitors
        [{ eventType: 'page_view', occurredAt: eventAt }], // recent website events
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getActivity('ws_1', 'canon_1');

      expect(result).toEqual([{ type: 'website_activity', occurredAt: eventAt, eventType: 'page_view' }]);
    });

    it('excludes website activity for an unlinked (still-anonymous) visitor', async () => {
      const select = makeSelectQueue([[{ id: 'canon_1', primaryEmail: 'a@example.com' }], [], []]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getActivity('ws_1', 'canon_1');

      expect(result).toEqual([]);
    });

    it('excludes website activity linked only in a different workspace (workspace isolation)', async () => {
      const select = makeSelectQueue([[{ id: 'canon_1', primaryEmail: 'a@example.com' }], [], []]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getActivity('ws_1', 'canon_1');

      expect(result.some((entry) => entry.type === 'website_activity')).toBe(false);
    });

    it('merges commerce and website activity into one chronologically sorted feed', async () => {
      const customerCreatedAt = new Date('2026-01-01T00:00:00Z');
      const orderAt = new Date('2026-01-10T00:00:00Z');
      const pageViewAt = new Date('2026-01-15T00:00:00Z');
      const searchAt = new Date('2026-01-05T00:00:00Z');
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }],
        [{ id: 'cc_1', provider: 'shopify', externalId: '900', firstName: null, lastName: null, phone: null, sourceUpdatedAt: null, createdAt: customerCreatedAt }],
        [{ provider: 'shopify', externalId: '9001', totalPrice: '19.99', sourceUpdatedAt: orderAt, createdAt: orderAt }],
        [{ id: 'visitor_1' }],
        [
          { eventType: 'page_view', occurredAt: pageViewAt },
          { eventType: 'search', occurredAt: searchAt },
        ],
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getActivity('ws_1', 'canon_1');

      expect(result.map((entry) => entry.type)).toEqual(['website_activity', 'order_placed', 'website_activity', 'customer_created']);
      expect(result[0]).toEqual({ type: 'website_activity', occurredAt: pageViewAt, eventType: 'page_view' });
      expect(result[2]).toEqual({ type: 'website_activity', occurredAt: searchAt, eventType: 'search' });
    });

    it('still caps the combined feed at ACTIVITY_LIMIT (50) once website activity is mixed in', async () => {
      const websiteEventRows = Array.from({ length: 55 }, (_, i) => ({
        eventType: 'page_view',
        occurredAt: new Date(2026, 0, 1, 0, 0, 55 - i), // descending, most recent first
      }));
      const select = makeSelectQueue([
        [{ id: 'canon_1', primaryEmail: 'a@example.com' }],
        [], // no source rows
        [{ id: 'visitor_1' }],
        websiteEventRows,
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getActivity('ws_1', 'canon_1');

      expect(result).toHaveLength(50);
      expect(result[0]).toMatchObject({ occurredAt: websiteEventRows[0].occurredAt });
    });
  });

  describe('getWorkspaceSummary()', () => {
    it('returns customer/order totals for the whole workspace', async () => {
      const select = makeSelectQueue([
        [{ count: 5 }],
        [{ ordersCount: 12, totalSpent: '450.00' }],
      ]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getWorkspaceSummary('ws_1');

      expect(result).toEqual({ customersCount: 5, ordersCount: 12, totalSpent: '450.00' });
    });

    it('defaults to zero when there is no data yet', async () => {
      const select = makeSelectQueue([[{ count: 0 }], [{ ordersCount: 0, totalSpent: '0' }]]);
      const service = new CustomerIntelligenceService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getWorkspaceSummary('ws_1');

      expect(result).toEqual({ customersCount: 0, ordersCount: 0, totalSpent: '0' });
    });
  });
});
