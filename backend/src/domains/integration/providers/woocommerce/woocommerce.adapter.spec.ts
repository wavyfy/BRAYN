import { afterEach, describe, expect, it, vi } from 'vitest';
import { WooCommerceAdapter } from './woocommerce.adapter';
import type { ProviderRegistry } from '../../provider-registry.service';

function makeRegistry(): ProviderRegistry {
  return { register: vi.fn() } as unknown as ProviderRegistry;
}

function jsonResponse(status: number, body: unknown = []) {
  return new Response(JSON.stringify(body), { status });
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
});
