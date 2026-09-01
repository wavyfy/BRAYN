import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShopifyAdapter } from './shopify.adapter';
import type { ProviderRegistry } from '../../provider-registry.service';

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
          },
        ],
        nextCursor: null,
      });
      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe('https://acme.myshopify.com/admin/api/2024-10/orders.json?limit=250&status=any');
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
});
