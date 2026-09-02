import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShopifyAdapter } from './shopify.adapter';
import type { ProviderRegistry } from '../../provider-registry.service';

function sign(rawBody: string, secret: string) {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

function makeRegistry(): ProviderRegistry {
  return { register: vi.fn() } as unknown as ProviderRegistry;
}

function jsonResponse(status: number, body: unknown = {}, headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('ShopifyAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers itself with the ProviderRegistry on module init', () => {
    const registry = makeRegistry();
    const adapter = new ShopifyAdapter(registry);

    adapter.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(adapter);
  });

  describe('verifyConnection()', () => {
    it('returns false when shopDomain or accessToken is missing', async () => {
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(adapter.verifyConnection({})).resolves.toBe(false);
      await expect(adapter.verifyConnection({ shopDomain: 'x.myshopify.com' })).resolves.toBe(false);
      await expect(adapter.verifyConnection({ accessToken: 'shpat_x' })).resolves.toBe(false);
    });

    it('returns true and calls shop.json with the access token header on success', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
        jsonResponse(200, { shop: { name: 'Acme' } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      const result = await adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(result).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://acme.myshopify.com/admin/api/2024-10/shop.json');
      expect((init?.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_123');
    });

    it('returns false (not a throw) on 401 — an invalid token is an ordinary rejection', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }),
      ).resolves.toBe(false);
    });

    it('returns false on 404 — an unknown shop domain is an ordinary rejection', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404)));
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.verifyConnection({ shopDomain: 'nonexistent.myshopify.com', accessToken: 'shpat_123' }),
      ).resolves.toBe(false);
    });

    it('returns false (not a throw, and never calls fetch) for a shopDomain outside myshopify.com — SSRF guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.verifyConnection({ shopDomain: 'internal.local', accessToken: 'shpat_123' }),
      ).resolves.toBe(false);
      await expect(
        adapter.verifyConnection({ shopDomain: 'evil.com/acme.myshopify.com', accessToken: 'shpat_123' }),
      ).resolves.toBe(false);
      await expect(
        adapter.verifyConnection({ shopDomain: 'acme.myshopify.com.evil.com', accessToken: 'shpat_123' }),
      ).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws ProviderError on a 5xx response — unexpected, not a credentials problem', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503)));
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError when the network request itself fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        }),
      );
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.verifyConnection({ shopDomain: 'bad.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });
  });

  describe('fetchCustomers()', () => {
    it('requests the first page with the access token header and normalizes the customer shape', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
        jsonResponse(200, {
          customers: [
            { id: 123, email: 'a@example.com', first_name: 'Ada', last_name: 'Lovelace', phone: null, updated_at: '2026-01-01T00:00:00Z' },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page).toEqual({
        customers: [
          {
            externalId: '123',
            email: 'a@example.com',
            firstName: 'Ada',
            lastName: 'Lovelace',
            phone: null,
            sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
          },
        ],
        nextCursor: null,
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://acme.myshopify.com/admin/api/2024-10/customers.json?limit=250');
      expect((init?.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_123');
    });

    it('extracts the next-page URL from the Link header', async () => {
      const nextUrl = 'https://acme.myshopify.com/admin/api/2024-10/customers.json?page_info=abc123';
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(200, { customers: [] }, { link: `<${nextUrl}>; rel="next"` }),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.nextCursor).toBe(nextUrl);
    });

    it('fetches a subsequent page directly from the cursor URL', async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => jsonResponse(200, { customers: [] }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());
      const cursor = 'https://acme.myshopify.com/admin/api/2024-10/customers.json?page_info=abc123';

      await adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, cursor);

      expect(fetchMock.mock.calls[0][0]).toBe(cursor);
    });

    it('appends updated_at_min on the first page when options.updatedAtMin is given (doc 06/20 — Incremental Synchronization)', async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => jsonResponse(200, { customers: [] }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      await adapter.fetchCustomers(
        { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' },
        undefined,
        { updatedAtMin: new Date('2026-01-01T00:00:00.000Z') },
      );

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://acme.myshopify.com/admin/api/2024-10/customers.json?limit=250&updated_at_min=2026-01-01T00%3A00%3A00.000Z',
      );
    });

    it('ignores options.updatedAtMin on a subsequent page — the cursor URL already carries it forward', async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => jsonResponse(200, { customers: [] }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());
      const cursor = 'https://acme.myshopify.com/admin/api/2024-10/customers.json?page_info=abc123&updated_at_min=2026-01-01T00%3A00%3A00.000Z';

      await adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, cursor, {
        updatedAtMin: new Date('2026-01-01T00:00:00.000Z'),
      });

      expect(fetchMock.mock.calls[0][0]).toBe(cursor);
    });

    it('throws ProviderError on a non-2xx response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError when the network request itself fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        }),
      );
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.fetchCustomers({ shopDomain: 'bad.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError and never calls fetch for a stored shopDomain outside myshopify.com — SSRF guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.fetchCustomers({ shopDomain: 'evil.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws ProviderError and never calls fetch when the cursor host does not match the shop — SSRF/exfil guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.fetchCustomers(
          { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' },
          'https://attacker.example/steal',
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('fetchProducts()', () => {
    it('requests the first page and normalizes products with their variants', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
        jsonResponse(200, {
          products: [
            {
              id: 55,
              title: 'Classic Tee',
              updated_at: '2026-01-01T00:00:00Z',
              variants: [
                { id: 901, sku: 'TEE-S', price: '19.99', inventory_quantity: 10, updated_at: '2026-01-02T00:00:00Z' },
              ],
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page).toEqual({
        products: [
          {
            externalId: '55',
            title: 'Classic Tee',
            sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
            variants: [
              {
                externalId: '901',
                sku: 'TEE-S',
                price: '19.99',
                inventoryQuantity: 10,
                sourceUpdatedAt: new Date('2026-01-02T00:00:00Z'),
              },
            ],
          },
        ],
        nextCursor: null,
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://acme.myshopify.com/admin/api/2024-10/products.json?limit=250');
      expect((init?.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_123');
    });

    it('extracts the next-page URL from the Link header', async () => {
      const nextUrl = 'https://acme.myshopify.com/admin/api/2024-10/products.json?page_info=abc123';
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { products: [] }, { link: `<${nextUrl}>; rel="next"` })));
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.nextCursor).toBe(nextUrl);
    });

    it('appends updated_at_min on the first page when options.updatedAtMin is given', async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => jsonResponse(200, { products: [] }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, undefined, {
        updatedAtMin: new Date('2026-01-01T00:00:00.000Z'),
      });

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://acme.myshopify.com/admin/api/2024-10/products.json?limit=250&updated_at_min=2026-01-01T00%3A00%3A00.000Z',
      );
    });

    it('throws ProviderError on a non-2xx response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError and never calls fetch for a stored shopDomain outside myshopify.com — SSRF guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.fetchProducts({ shopDomain: 'evil.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('fetchOrders()', () => {
    it('requests status=any and normalizes orders with their line items', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
        jsonResponse(200, {
          orders: [
            {
              id: 900,
              customer: { id: 1 },
              total_price: '19.99',
              updated_at: '2026-01-01T00:00:00Z',
              line_items: [{ id: 9001, variant_id: 901, quantity: 2, price: '9.99' }],
            },
          ],
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page).toEqual({
        orders: [
          {
            externalId: '900',
            customerExternalId: '1',
            totalPrice: '19.99',
            sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
            lineItems: [{ externalId: '9001', variantExternalId: '901', quantity: 2, price: '9.99' }],
            refunds: [],
            fulfillments: [],
          },
        ],
        nextCursor: null,
      });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://acme.myshopify.com/admin/api/2024-10/orders.json?limit=250&status=any');
    });

    it('appends updated_at_min after status=any on the first page when options.updatedAtMin is given', async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => jsonResponse(200, { orders: [] }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, undefined, {
        updatedAtMin: new Date('2026-01-01T00:00:00.000Z'),
      });

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://acme.myshopify.com/admin/api/2024-10/orders.json?limit=250&status=any&updated_at_min=2026-01-01T00%3A00%3A00.000Z',
      );
    });

    it('normalizes a null customer (guest checkout) and a null variant_id (custom line) to null', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(200, {
            orders: [
              {
                id: 901,
                customer: null,
                total_price: '5.00',
                updated_at: '2026-01-01T00:00:00Z',
                line_items: [{ id: 9002, variant_id: null, quantity: 1, price: '5.00' }],
              },
            ],
          }),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.orders[0].customerExternalId).toBeNull();
      expect(page.orders[0].lineItems[0].variantExternalId).toBeNull();
    });

    it('extracts the next-page URL from the Link header', async () => {
      const nextUrl = 'https://acme.myshopify.com/admin/api/2024-10/orders.json?page_info=abc123';
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { orders: [] }, { link: `<${nextUrl}>; rel="next"` })));
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.nextCursor).toBe(nextUrl);
    });

    it('throws ProviderError on a non-2xx response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('normalizes an order\'s embedded refunds, summing only successful transaction amounts', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(200, {
            orders: [
              {
                id: 900,
                customer: { id: 1 },
                total_price: '19.99',
                updated_at: '2026-01-01T00:00:00Z',
                line_items: [{ id: 9001, variant_id: 901, quantity: 2, price: '9.99' }],
                refunds: [
                  {
                    id: 9500,
                    note: 'Damaged item',
                    processed_at: '2026-01-02T00:00:00Z',
                    refund_line_items: [{ id: 9501, line_item_id: 9001, quantity: 1 }],
                    transactions: [
                      { amount: '9.99', status: 'success' },
                      { amount: '9.99', status: 'pending' },
                    ],
                  },
                ],
              },
            ],
          }),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.orders[0].refunds).toEqual([
        {
          externalId: '9500',
          note: 'Damaged item',
          totalRefunded: '9.99',
          processedAt: new Date('2026-01-02T00:00:00Z'),
          lineItems: [{ externalId: '9501', orderLineItemExternalId: '9001', quantity: 1 }],
        },
      ]);
    });

    it('normalizes an order with no refunds field to an empty refunds array', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(200, {
            orders: [
              { id: 902, customer: null, total_price: '5.00', updated_at: '2026-01-01T00:00:00Z', line_items: [] },
            ],
          }),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.orders[0].refunds).toEqual([]);
      expect(page.orders[0].fulfillments).toEqual([]);
    });

    it("normalizes an order's embedded fulfillments", async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(200, {
            orders: [
              {
                id: 900,
                customer: { id: 1 },
                total_price: '19.99',
                updated_at: '2026-01-01T00:00:00Z',
                line_items: [],
                fulfillments: [
                  {
                    id: 7001,
                    order_id: 900,
                    status: 'success',
                    tracking_company: 'UPS',
                    tracking_number: '1Z999',
                    tracking_url: 'https://ups.com/track/1Z999',
                    shipment_status: 'in_transit',
                    updated_at: '2026-01-03T00:00:00Z',
                  },
                ],
              },
            ],
          }),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.orders[0].fulfillments).toEqual([
        {
          externalId: '7001',
          status: 'success',
          trackingCompany: 'UPS',
          trackingNumber: '1Z999',
          trackingUrl: 'https://ups.com/track/1Z999',
          shipmentStatus: 'in_transit',
          sourceUpdatedAt: new Date('2026-01-03T00:00:00Z'),
        },
      ]);
    });

    it('throws ProviderError and never calls fetch for a stored shopDomain outside myshopify.com — SSRF guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      await expect(
        adapter.fetchOrders({ shopDomain: 'evil.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('verifyWebhookSignature()', () => {
    it('returns true for a correctly signed body', () => {
      const adapter = new ShopifyAdapter(makeRegistry());
      const rawBody = '{"id":1}';
      const signature = sign(rawBody, 'shhh');

      expect(adapter.verifyWebhookSignature(rawBody, { 'x-shopify-hmac-sha256': signature }, 'shhh')).toBe(true);
    });

    it('returns false when the signature does not match', () => {
      const adapter = new ShopifyAdapter(makeRegistry());

      expect(
        adapter.verifyWebhookSignature('{"id":1}', { 'x-shopify-hmac-sha256': 'bogus==' }, 'shhh'),
      ).toBe(false);
    });

    it('returns false when the body was tampered with after signing', () => {
      const adapter = new ShopifyAdapter(makeRegistry());
      const signature = sign('{"id":1}', 'shhh');

      expect(
        adapter.verifyWebhookSignature('{"id":2}', { 'x-shopify-hmac-sha256': signature }, 'shhh'),
      ).toBe(false);
    });

    it('returns false when the signature header is missing', () => {
      const adapter = new ShopifyAdapter(makeRegistry());

      expect(adapter.verifyWebhookSignature('{"id":1}', {}, 'shhh')).toBe(false);
    });
  });

  describe('fetchCollections()', () => {
    it('fetches custom_collections first, and stays in that phase while pages remain', async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () =>
        jsonResponse(
          200,
          { custom_collections: [{ id: 10, title: 'Summer Sale', updated_at: '2026-01-01T00:00:00Z' }] },
          { link: '<https://acme.myshopify.com/admin/api/2024-10/custom_collections.json?page_info=abc>; rel="next"' },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page).toEqual({
        collections: [{ externalId: '10', title: 'Summer Sale', sourceUpdatedAt: new Date('2026-01-01T00:00:00Z') }],
        nextCursor: 'custom:https://acme.myshopify.com/admin/api/2024-10/custom_collections.json?page_info=abc',
      });
      expect(fetchMock.mock.calls[0][0]).toBe('https://acme.myshopify.com/admin/api/2024-10/custom_collections.json?limit=250');
    });

    it('continues custom_collections pagination when the cursor carries the custom: phase prefix', async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => jsonResponse(200, { custom_collections: [] }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      await adapter.fetchCollections(
        { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' },
        'custom:https://acme.myshopify.com/admin/api/2024-10/custom_collections.json?page_info=abc',
      );

      expect(fetchMock.mock.calls[0][0]).toBe('https://acme.myshopify.com/admin/api/2024-10/custom_collections.json?page_info=abc');
    });

    it('switches to smart_collections once custom_collections pages run out, in the same call', async () => {
      const fetchMock = vi
        .fn<(url: string) => Promise<Response>>()
        .mockResolvedValueOnce(jsonResponse(200, { custom_collections: [{ id: 10, title: 'Summer Sale', updated_at: '2026-01-01T00:00:00Z' }] }))
        .mockResolvedValueOnce(
          jsonResponse(200, { smart_collections: [{ id: 20, title: 'Best Sellers', updated_at: '2026-01-02T00:00:00Z' }] }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.collections).toEqual([
        { externalId: '10', title: 'Summer Sale', sourceUpdatedAt: new Date('2026-01-01T00:00:00Z') },
        { externalId: '20', title: 'Best Sellers', sourceUpdatedAt: new Date('2026-01-02T00:00:00Z') },
      ]);
      expect(page.nextCursor).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe('https://acme.myshopify.com/admin/api/2024-10/smart_collections.json?limit=250');
    });

    it('continues smart_collections pagination when the cursor carries the smart: phase prefix', async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => jsonResponse(200, { smart_collections: [] }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchCollections(
        { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' },
        'smart:https://acme.myshopify.com/admin/api/2024-10/smart_collections.json?page_info=xyz',
      );

      expect(fetchMock.mock.calls[0][0]).toBe('https://acme.myshopify.com/admin/api/2024-10/smart_collections.json?page_info=xyz');
      expect(page.nextCursor).toBeNull();
    });

    it('appends updated_at_min to both custom and smart phase requests when options.updatedAtMin is given', async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => jsonResponse(200, { custom_collections: [], smart_collections: [] }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      await adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, undefined, {
        updatedAtMin: new Date('2026-01-01T00:00:00.000Z'),
      });

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://acme.myshopify.com/admin/api/2024-10/custom_collections.json?limit=250&updated_at_min=2026-01-01T00%3A00%3A00.000Z',
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        'https://acme.myshopify.com/admin/api/2024-10/smart_collections.json?limit=250&updated_at_min=2026-01-01T00%3A00%3A00.000Z',
      );
    });
  });

  describe('fetchCollects()', () => {
    it('fetches the shop-wide collects list and normalizes each membership link', async () => {
      const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () =>
        jsonResponse(200, { collects: [{ id: 500, collection_id: 10, product_id: 55 }] }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry());

      const page = await adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page).toEqual({
        collects: [{ externalId: '500', collectionExternalId: '10', productExternalId: '55' }],
        nextCursor: null,
      });
      expect(fetchMock.mock.calls[0][0]).toBe('https://acme.myshopify.com/admin/api/2024-10/collects.json?limit=250');
    });
  });

  describe('parseWebhookEvent()', () => {
    it('normalizes a customers/update delivery, using the X-Shopify-Webhook-Id header as the dedupe key', () => {
      const adapter = new ShopifyAdapter(makeRegistry());
      const rawBody = JSON.stringify({
        id: 1,
        email: 'a@x.com',
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone: null,
        updated_at: '2026-01-01T00:00:00Z',
      });

      const result = adapter.parseWebhookEvent(rawBody, {
        'x-shopify-topic': 'customers/update',
        'x-shopify-webhook-id': 'wh_evt_1',
      });

      expect(result).toEqual({
        externalEventId: 'wh_evt_1',
        eventType: 'customers/update',
        payload: {
          resource: 'customer',
          data: {
            externalId: '1',
            email: 'a@x.com',
            firstName: 'Ada',
            lastName: 'Lovelace',
            phone: null,
            sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
          },
        },
      });
    });

    it('normalizes a products/create delivery with nested variants', () => {
      const adapter = new ShopifyAdapter(makeRegistry());
      const rawBody = JSON.stringify({
        id: 55,
        title: 'Classic Tee',
        updated_at: '2026-01-01T00:00:00Z',
        variants: [{ id: 901, sku: 'TEE-S', price: '19.99', inventory_quantity: 10, updated_at: '2026-01-02T00:00:00Z' }],
      });

      const result = adapter.parseWebhookEvent(rawBody, {
        'x-shopify-topic': 'products/create',
        'x-shopify-webhook-id': 'wh_evt_2',
      });

      expect(result?.payload).toMatchObject({
        resource: 'product',
        data: { externalId: '55', title: 'Classic Tee', variants: [{ externalId: '901', sku: 'TEE-S' }] },
      });
    });

    it('normalizes an orders/updated delivery with a guest customer as null', () => {
      const adapter = new ShopifyAdapter(makeRegistry());
      const rawBody = JSON.stringify({
        id: 900,
        customer: null,
        total_price: '19.99',
        updated_at: '2026-01-01T00:00:00Z',
        line_items: [],
      });

      const result = adapter.parseWebhookEvent(rawBody, {
        'x-shopify-topic': 'orders/updated',
        'x-shopify-webhook-id': 'wh_evt_3',
      });

      expect(result?.payload).toMatchObject({ resource: 'order', data: { externalId: '900', customerExternalId: null } });
    });

    it('normalizes a fulfillments/create delivery — bare fulfillment plus order_id, no nested order', () => {
      const adapter = new ShopifyAdapter(makeRegistry());
      const rawBody = JSON.stringify({
        id: 7001,
        order_id: 900,
        status: 'success',
        tracking_company: 'UPS',
        tracking_number: '1Z999',
        tracking_url: 'https://ups.com/track/1Z999',
        shipment_status: null,
        updated_at: '2026-01-03T00:00:00Z',
      });

      const result = adapter.parseWebhookEvent(rawBody, {
        'x-shopify-topic': 'fulfillments/create',
        'x-shopify-webhook-id': 'wh_evt_4',
      });

      expect(result?.payload).toEqual({
        resource: 'fulfillment',
        data: {
          externalId: '7001',
          orderExternalId: '900',
          status: 'success',
          trackingCompany: 'UPS',
          trackingNumber: '1Z999',
          trackingUrl: 'https://ups.com/track/1Z999',
          shipmentStatus: null,
          sourceUpdatedAt: new Date('2026-01-03T00:00:00Z'),
        },
      });
    });

    it('recognizes fulfillments/update the same way as fulfillments/create', () => {
      const adapter = new ShopifyAdapter(makeRegistry());
      const rawBody = JSON.stringify({
        id: 7002,
        order_id: 901,
        status: 'success',
        tracking_company: null,
        tracking_number: null,
        tracking_url: null,
        shipment_status: 'delivered',
        updated_at: '2026-01-04T00:00:00Z',
      });

      const result = adapter.parseWebhookEvent(rawBody, {
        'x-shopify-topic': 'fulfillments/update',
        'x-shopify-webhook-id': 'wh_evt_5',
      });

      expect(result?.payload).toMatchObject({ resource: 'fulfillment', data: { externalId: '7002', orderExternalId: '901', shipmentStatus: 'delivered' } });
    });

    it('normalizes a collections/create delivery — same bare shape for custom and smart collections', () => {
      const adapter = new ShopifyAdapter(makeRegistry());
      const rawBody = JSON.stringify({ id: 10, title: 'Summer Sale', updated_at: '2026-01-01T00:00:00Z' });

      const result = adapter.parseWebhookEvent(rawBody, {
        'x-shopify-topic': 'collections/create',
        'x-shopify-webhook-id': 'wh_evt_6',
      });

      expect(result?.payload).toEqual({
        resource: 'collection',
        data: { externalId: '10', title: 'Summer Sale', sourceUpdatedAt: new Date('2026-01-01T00:00:00Z') },
      });
    });

    it('recognizes collections/update the same way as collections/create', () => {
      const adapter = new ShopifyAdapter(makeRegistry());
      const rawBody = JSON.stringify({ id: 11, title: 'Best Sellers', updated_at: '2026-01-02T00:00:00Z' });

      const result = adapter.parseWebhookEvent(rawBody, {
        'x-shopify-topic': 'collections/update',
        'x-shopify-webhook-id': 'wh_evt_7',
      });

      expect(result?.payload).toMatchObject({ resource: 'collection', data: { externalId: '11', title: 'Best Sellers' } });
    });

    it('returns null for an unrecognized topic (e.g. a delete event) — doc 21 "process only relevant events"', () => {
      const adapter = new ShopifyAdapter(makeRegistry());

      const result = adapter.parseWebhookEvent('{}', { 'x-shopify-topic': 'customers/delete' });

      expect(result).toBeNull();
    });

    it('returns null when the topic header is missing entirely', () => {
      const adapter = new ShopifyAdapter(makeRegistry());

      expect(adapter.parseWebhookEvent('{}', {})).toBeNull();
    });

    it('returns null for unparseable JSON', () => {
      const adapter = new ShopifyAdapter(makeRegistry());

      expect(adapter.parseWebhookEvent('not json', { 'x-shopify-topic': 'customers/update' })).toBeNull();
    });

    it('derives a stable fallback event id when X-Shopify-Webhook-Id is absent', () => {
      const adapter = new ShopifyAdapter(makeRegistry());
      const rawBody = JSON.stringify({ id: 1, email: null, first_name: null, last_name: null, phone: null, updated_at: '2026-01-01T00:00:00Z' });

      const first = adapter.parseWebhookEvent(rawBody, { 'x-shopify-topic': 'customers/update' });
      const second = adapter.parseWebhookEvent(rawBody, { 'x-shopify-topic': 'customers/update' });

      expect(first?.externalEventId).toBeTruthy();
      expect(first?.externalEventId).toBe(second?.externalEventId);
    });
  });
});
