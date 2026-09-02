import { afterEach, describe, expect, it, vi } from 'vitest';
import { WooCommerceAdapter } from './woocommerce.adapter';
import type { ProviderRegistry } from '../../provider-registry.service';

function makeRegistry(): ProviderRegistry {
  return { register: vi.fn() } as unknown as ProviderRegistry;
}

function jsonResponse(status: number, body: unknown = [], headers?: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('WooCommerceAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers itself with the ProviderRegistry on module init', () => {
    const registry = makeRegistry();
    const adapter = new WooCommerceAdapter(registry);

    adapter.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(adapter);
  });

  describe('verifyConnection()', () => {
    it('returns false when storeUrl, consumerKey, or consumerSecret is missing', async () => {
      const adapter = new WooCommerceAdapter(makeRegistry());

      await expect(adapter.verifyConnection({})).resolves.toBe(false);
      await expect(adapter.verifyConnection({ storeUrl: 'https://x.com' })).resolves.toBe(false);
      await expect(adapter.verifyConnection({ storeUrl: 'https://x.com', consumerKey: 'ck_1' })).resolves.toBe(false);
    });

    it('returns true and calls customers?per_page=1 with Basic Auth on success', async () => {
      const fetchMock = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(async () => jsonResponse(200, []));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WooCommerceAdapter(makeRegistry());

      const result = await adapter.verifyConnection({
        storeUrl: 'https://merchant-store.com',
        consumerKey: 'ck_123',
        consumerSecret: 'cs_456',
      });

      expect(result).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://merchant-store.com/wp-json/wc/v3/customers?per_page=1');
      const expectedAuth = `Basic ${Buffer.from('ck_123:cs_456').toString('base64')}`;
      expect((init?.headers as Record<string, string>).Authorization).toBe(expectedAuth);
    });

    it('resolves the WooCommerce path relative to a store URL with a subpath', async () => {
      const fetchMock = vi.fn<(url: string | URL) => Promise<Response>>(async () => jsonResponse(200, []));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WooCommerceAdapter(makeRegistry());

      await adapter.verifyConnection({
        storeUrl: 'https://example.com/shop/',
        consumerKey: 'ck_123',
        consumerSecret: 'cs_456',
      });

      expect(String(fetchMock.mock.calls[0][0])).toBe('https://example.com/shop/wp-json/wc/v3/customers?per_page=1');
    });

    it('returns false (not a throw) on 401 — invalid consumer key/secret is an ordinary rejection', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
      const adapter = new WooCommerceAdapter(makeRegistry());

      await expect(
        adapter.verifyConnection({ storeUrl: 'https://merchant-store.com', consumerKey: 'bad', consumerSecret: 'bad' }),
      ).resolves.toBe(false);
    });

    it('returns false on 404 — REST API not enabled or wrong URL is an ordinary rejection', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404)));
      const adapter = new WooCommerceAdapter(makeRegistry());

      await expect(
        adapter.verifyConnection({ storeUrl: 'https://not-woo.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' }),
      ).resolves.toBe(false);
    });

    it('returns false for a malformed storeUrl', async () => {
      const adapter = new WooCommerceAdapter(makeRegistry());

      await expect(
        adapter.verifyConnection({ storeUrl: 'not a url', consumerKey: 'ck_1', consumerSecret: 'cs_1' }),
      ).resolves.toBe(false);
    });

    it('returns false (not a throw, and never calls fetch) for a non-HTTPS storeUrl', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WooCommerceAdapter(makeRegistry());

      await expect(
        adapter.verifyConnection({ storeUrl: 'http://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' }),
      ).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns false (not a throw, and never calls fetch) for a loopback/private/link-local storeUrl — SSRF guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WooCommerceAdapter(makeRegistry());
      const creds = { consumerKey: 'ck_1', consumerSecret: 'cs_1' };

      await expect(adapter.verifyConnection({ storeUrl: 'https://localhost', ...creds })).resolves.toBe(false);
      await expect(adapter.verifyConnection({ storeUrl: 'https://127.0.0.1', ...creds })).resolves.toBe(false);
      await expect(adapter.verifyConnection({ storeUrl: 'https://10.0.0.5', ...creds })).resolves.toBe(false);
      await expect(adapter.verifyConnection({ storeUrl: 'https://192.168.1.1', ...creds })).resolves.toBe(false);
      await expect(adapter.verifyConnection({ storeUrl: 'https://172.16.0.1', ...creds })).resolves.toBe(false);
      await expect(adapter.verifyConnection({ storeUrl: 'https://169.254.169.254', ...creds })).resolves.toBe(false);
      await expect(adapter.verifyConnection({ storeUrl: 'https://[::1]', ...creds })).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws ProviderError on a 5xx response — unexpected, not a credentials problem', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503)));
      const adapter = new WooCommerceAdapter(makeRegistry());

      await expect(
        adapter.verifyConnection({ storeUrl: 'https://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError when the network request itself fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        }),
      );
      const adapter = new WooCommerceAdapter(makeRegistry());

      await expect(
        adapter.verifyConnection({ storeUrl: 'https://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });
  });

  describe('fetchCustomers()', () => {
    it('requests the first page with Basic Auth and normalizes the customer shape', async () => {
      const fetchMock = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(async () =>
        jsonResponse(200, [
          {
            id: 123,
            email: 'a@example.com',
            first_name: 'Ada',
            last_name: 'Lovelace',
            date_modified_gmt: '2026-01-01T00:00:00',
            billing: { phone: '555-1234' },
          },
        ]),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WooCommerceAdapter(makeRegistry());

      const page = await adapter.fetchCustomers({ storeUrl: 'https://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' });

      expect(page).toEqual({
        customers: [
          {
            externalId: '123',
            email: 'a@example.com',
            firstName: 'Ada',
            lastName: 'Lovelace',
            phone: '555-1234',
            sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
          },
        ],
        nextCursor: null,
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('https://merchant-store.com/wp-json/wc/v3/customers?per_page=100');
      const expectedAuth = `Basic ${Buffer.from('ck_1:cs_1').toString('base64')}`;
      expect((init?.headers as Record<string, string>).Authorization).toBe(expectedAuth);
    });

    it('normalizes a missing billing.phone and a missing date_modified_gmt to null', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(200, [{ id: 1, email: null, first_name: null, last_name: null, date_modified_gmt: null }])),
      );
      const adapter = new WooCommerceAdapter(makeRegistry());

      const page = await adapter.fetchCustomers({ storeUrl: 'https://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' });

      expect(page.customers[0].phone).toBeNull();
      expect(page.customers[0].sourceUpdatedAt).toBeNull();
    });

    it('extracts the next-page URL from the Link header', async () => {
      const nextUrl = 'https://merchant-store.com/wp-json/wc/v3/customers?per_page=100&page=2';
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, [], { link: `<${nextUrl}>; rel="next"` })));
      const adapter = new WooCommerceAdapter(makeRegistry());

      const page = await adapter.fetchCustomers({ storeUrl: 'https://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' });

      expect(page.nextCursor).toBe(nextUrl);
    });

    it('continues pagination using the exact cursor URL on the next call', async () => {
      const fetchMock = vi.fn<(url: string | URL) => Promise<Response>>(async () => jsonResponse(200, []));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WooCommerceAdapter(makeRegistry());
      const cursor = 'https://merchant-store.com/wp-json/wc/v3/customers?per_page=100&page=2';

      await adapter.fetchCustomers({ storeUrl: 'https://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' }, cursor);

      expect(String(fetchMock.mock.calls[0][0])).toBe(cursor);
    });

    it('throws ProviderError and never calls fetch for a cursor host that does not match the connected store — SSRF guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WooCommerceAdapter(makeRegistry());

      await expect(
        adapter.fetchCustomers(
          { storeUrl: 'https://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' },
          'https://evil.com/wp-json/wc/v3/customers?page=2',
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws ProviderError on a non-2xx response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500)));
      const adapter = new WooCommerceAdapter(makeRegistry());

      await expect(
        adapter.fetchCustomers({ storeUrl: 'https://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });
  });

  describe('fetchProducts()', () => {
    it('requests the first page and maps a simple product to a single synthetic variant from its own top-level fields', async () => {
      const fetchMock = vi.fn<(url: string | URL) => Promise<Response>>(async () =>
        jsonResponse(200, [
          { id: 55, name: 'Tee', date_modified_gmt: '2026-01-01T00:00:00', sku: 'TEE-1', price: '19.99', stock_quantity: 8 },
        ]),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new WooCommerceAdapter(makeRegistry());

      const page = await adapter.fetchProducts({ storeUrl: 'https://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' });

      expect(page).toEqual({
        products: [
          {
            externalId: '55',
            title: 'Tee',
            sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
            variants: [
              { externalId: '55', sku: 'TEE-1', price: '19.99', inventoryQuantity: 8, sourceUpdatedAt: new Date('2026-01-01T00:00:00Z') },
            ],
          },
        ],
        nextCursor: null,
      });
      expect(String(fetchMock.mock.calls[0][0])).toBe('https://merchant-store.com/wp-json/wc/v3/products?per_page=100');
    });

    it('normalizes a null sku/price/stock_quantity/date_modified_gmt to null throughout', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => jsonResponse(200, [{ id: 56, name: 'Custom Item', date_modified_gmt: null, sku: null, price: null, stock_quantity: null }])),
      );
      const adapter = new WooCommerceAdapter(makeRegistry());

      const page = await adapter.fetchProducts({ storeUrl: 'https://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' });

      expect(page.products[0].sourceUpdatedAt).toBeNull();
      expect(page.products[0].variants[0]).toEqual({ externalId: '56', sku: null, price: null, inventoryQuantity: null, sourceUpdatedAt: null });
    });

    it('extracts the next-page URL from the Link header', async () => {
      const nextUrl = 'https://merchant-store.com/wp-json/wc/v3/products?per_page=100&page=2';
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, [], { link: `<${nextUrl}>; rel="next"` })));
      const adapter = new WooCommerceAdapter(makeRegistry());

      const page = await adapter.fetchProducts({ storeUrl: 'https://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' });

      expect(page.nextCursor).toBe(nextUrl);
    });

    it('throws ProviderError on a non-2xx response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500)));
      const adapter = new WooCommerceAdapter(makeRegistry());

      await expect(
        adapter.fetchProducts({ storeUrl: 'https://merchant-store.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });
  });
});
