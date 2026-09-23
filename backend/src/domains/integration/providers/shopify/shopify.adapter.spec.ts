import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShopifyAdapter } from './shopify.adapter';
import type { ProviderRegistry } from '../../provider-registry.service';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../../config/env.schema';

function sign(rawBody: string, secret: string) {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

function makeRegistry(): ProviderRegistry {
  return { register: vi.fn() } as unknown as ProviderRegistry;
}

function makeConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const env: Partial<Env> = { SHOPIFY_APP_CLIENT_ID: 'client_id', SHOPIFY_APP_CLIENT_SECRET: 'client_secret', ...overrides };
  return { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
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
    const adapter = new ShopifyAdapter(registry, makeConfig());

    adapter.onModuleInit();

    expect(registry.register).toHaveBeenCalledWith(adapter);
  });

  describe('verifyConnection()', () => {
    it('returns false when shopDomain or accessToken is missing', async () => {
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(adapter.verifyConnection({})).resolves.toBe(false);
      await expect(adapter.verifyConnection({ shopDomain: 'x.myshopify.com' })).resolves.toBe(false);
      await expect(adapter.verifyConnection({ accessToken: 'shpat_x' })).resolves.toBe(false);
    });

    it('returns true and calls the GraphQL endpoint with the access token header on success', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
        jsonResponse(200, { data: { shop: { id: 'gid://shopify/Shop/1' } } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const result = await adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(result).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://acme.myshopify.com/admin/api/2024-10/graphql.json');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_123');
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(JSON.parse(init?.body as string)).toEqual({ query: '{ shop { id } }' });
    });

    it('returns false (not a throw) on 401 — an invalid token is an ordinary rejection', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }),
      ).resolves.toBe(false);
    });

    it('returns false on 404 — an unknown shop domain is an ordinary rejection', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404)));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.verifyConnection({ shopDomain: 'nonexistent.myshopify.com', accessToken: 'shpat_123' }),
      ).resolves.toBe(false);
    });

    it('returns false (not a throw, and never calls fetch) for a shopDomain outside myshopify.com — SSRF guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

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
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

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
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.verifyConnection({ shopDomain: 'bad.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    describe('onDiagnostic (doc 20 Part 20) — status-code category only, never the token/domain/body', () => {
      it('reports category "200" plus the X-Shopify-API-Version header on success', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => jsonResponse(200, { data: { shop: { id: 'gid://shopify/Shop/1' } } }, { 'X-Shopify-API-Version': '2024-10' })),
        );
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, onDiagnostic);

        expect(onDiagnostic).toHaveBeenCalledWith({ category: '200', apiVersionHeader: '2024-10', shopifyError: null });
      });

      it('reports category "401" (not a combined 401/403 bucket) for a 401', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }, onDiagnostic);

        expect(onDiagnostic).toHaveBeenCalledWith({ category: '401', apiVersionHeader: null, shopifyError: null });
      });

      it('reports category "403" (distinct from 401) for a 403', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403)));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }, onDiagnostic);

        expect(onDiagnostic).toHaveBeenCalledWith({ category: '403', apiVersionHeader: null, shopifyError: null });
      });

      it('reports category "404" for an unknown shop domain', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(404)));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await adapter.verifyConnection({ shopDomain: 'nonexistent.myshopify.com', accessToken: 'shpat_123' }, onDiagnostic);

        expect(onDiagnostic).toHaveBeenCalledWith({ category: '404', apiVersionHeader: null, shopifyError: null });
      });

      it('reports category "other_4xx" for a 4xx that is neither 401/403 nor 404', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(429)));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, onDiagnostic);

        expect(onDiagnostic).toHaveBeenCalledWith({ category: 'other_4xx', apiVersionHeader: null, shopifyError: null });
      });

      it('reports category "server_error" (before throwing) for a 5xx', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503)));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await expect(
          adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, onDiagnostic),
        ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
        expect(onDiagnostic).toHaveBeenCalledWith({ category: 'server_error', apiVersionHeader: null, shopifyError: null });
      });

      it('reports category "network_error" (before throwing) when the request itself fails', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            throw new Error('getaddrinfo ENOTFOUND');
          }),
        );
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await expect(
          adapter.verifyConnection({ shopDomain: 'bad.myshopify.com', accessToken: 'shpat_123' }, onDiagnostic),
        ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
        expect(onDiagnostic).toHaveBeenCalledWith({ category: 'network_error', apiVersionHeader: null, shopifyError: null });
      });

      it('extracts a string "errors" field from a 403 body as shopifyError', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { errors: 'This action requires merchant approval for write_products scope' })));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }, onDiagnostic);

        expect(onDiagnostic).toHaveBeenCalledWith(
          expect.objectContaining({ category: '403', shopifyError: 'This action requires merchant approval for write_products scope' }),
        );
      });

      it('extracts an object-shaped "errors" field (validation-style) as a JSON string, not the raw object', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { errors: { scope: ['is missing'] } })));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }, onDiagnostic);

        expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ shopifyError: JSON.stringify({ scope: ['is missing'] }) }));
      });

      it('reports shopifyError: null when the body has no "errors" field', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { message: 'forbidden' })));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }, onDiagnostic);

        expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ shopifyError: null }));
      });

      it('reports shopifyError: null (fails closed, never throws) when the body is not valid JSON', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 403 })));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await expect(adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }, onDiagnostic)).resolves.toBe(false);
        expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ shopifyError: null }));
      });

      it('never includes the access token, shop domain, or unrelated body fields in the diagnostic payload — only the "errors" field', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => jsonResponse(401, { errors: 'invalid api key or access token', customer_email: 'jane@example.com', order_id: 999 })),
        );
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_super_secret_token' }, onDiagnostic);

        const serialized = JSON.stringify(onDiagnostic.mock.calls);
        expect(serialized).not.toContain('shpat_super_secret_token');
        expect(serialized).not.toContain('acme.myshopify.com');
        expect(serialized).not.toContain('jane@example.com');
        expect(serialized).not.toContain('order_id');
        expect(serialized).toContain('invalid api key or access token');
      });

      it('does not change behavior for callers that omit onDiagnostic (e.g. connectViaClientCredentials)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: { shop: { id: 'gid://shopify/Shop/1' } } })));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

        await expect(adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' })).resolves.toBe(true);
      });

      it('reports category "graphql_errors" (not success) for HTTP 200 with a GraphQL errors[] body — e.g. throttled', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { errors: [{ message: 'Throttled' }] })));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await expect(
          adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, onDiagnostic),
        ).resolves.toBe(false);
        expect(onDiagnostic).toHaveBeenCalledWith({ category: 'graphql_errors', apiVersionHeader: null, shopifyError: 'Throttled' });
      });

      it('joins multiple GraphQL error messages with "; "', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => jsonResponse(200, { errors: [{ message: 'first problem' }, { message: 'second problem' }] })),
        );
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, onDiagnostic);

        expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ shopifyError: 'first problem; second problem' }));
      });

      it('reports category "graphql_errors" (fails closed, not a throw) for an HTTP 200 body with neither data.shop nor errors', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: null })));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await expect(
          adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, onDiagnostic),
        ).resolves.toBe(false);
        expect(onDiagnostic).toHaveBeenCalledWith({ category: 'graphql_errors', apiVersionHeader: null, shopifyError: null });
      });

      it('reports category "graphql_errors" (fails closed, not a throw) for an HTTP 200 body that is not valid JSON', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const onDiagnostic = vi.fn();

        await expect(
          adapter.verifyConnection({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, onDiagnostic),
        ).resolves.toBe(false);
        expect(onDiagnostic).toHaveBeenCalledWith({ category: 'graphql_errors', apiVersionHeader: null, shopifyError: null });
      });
    });
  });

  describe('fetchCustomers() — GraphQL', () => {
    function graphqlCustomersResponse(
      nodes: { id: string; email: string | null; firstName: string | null; lastName: string | null; phone: string | null; updatedAt: string }[],
      pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
    ) {
      return jsonResponse(200, { data: { customers: { edges: nodes.map((node) => ({ node })), pageInfo } } });
    }

    it('requests the first page over GraphQL and normalizes the customer shape (GID -> plain numeric externalId)', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
        graphqlCustomersResponse([
          {
            id: 'gid://shopify/Customer/123',
            email: 'a@example.com',
            firstName: 'Ada',
            lastName: 'Lovelace',
            phone: null,
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ]),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

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
      expect(url).toBe('https://acme.myshopify.com/admin/api/2024-10/graphql.json');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_123');
      const sentBody = JSON.parse(init?.body as string) as { query: string; variables: Record<string, unknown> };
      expect(sentBody.query).toContain('customers(first: $first, after: $after, query: $query)');
      expect(sentBody.variables).toEqual({ first: 250 });
    });

    it('paginates using endCursor/hasNextPage — no next page yields nextCursor: null', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => graphqlCustomersResponse([], { hasNextPage: false, endCursor: 'cursorZ' })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.nextCursor).toBeNull();
    });

    it('returns endCursor as nextCursor when hasNextPage is true', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => graphqlCustomersResponse([], { hasNextPage: true, endCursor: 'cursorA' })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.nextCursor).toBe('cursorA');
    });

    it('sends the prior page cursor as the "after" variable on a subsequent page', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlCustomersResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, 'cursorA');

      const sentBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { variables: Record<string, unknown> };
      expect(sentBody.variables).toEqual({ first: 250, after: 'cursorA' });
    });

    it('sends options.updatedAtMin as the "query" variable on every page, not just the first (GraphQL cursors do not carry a search filter forward the way REST Link headers do)', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlCustomersResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
      const options = { updatedAtMin: new Date('2026-01-01T00:00:00.000Z') };

      await adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, undefined, options);
      await adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, 'cursorA', options);

      const firstBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { variables: Record<string, unknown> };
      const secondBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string) as { variables: Record<string, unknown> };
      expect(firstBody.variables).toEqual({ first: 250, query: "updated_at:>='2026-01-01T00:00:00.000Z'" });
      expect(secondBody.variables).toEqual({ first: 250, after: 'cursorA', query: "updated_at:>='2026-01-01T00:00:00.000Z'" });
    });

    it('returns an empty customer list for an empty connection', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => graphqlCustomersResponse([])));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page).toEqual({ customers: [], nextCursor: null });
    });

    it('throws ProviderError on a non-2xx response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

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
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCustomers({ shopDomain: 'bad.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError on an HTTP 200 response carrying a GraphQL errors[] body — e.g. throttled', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { errors: [{ message: 'Throttled' }] })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError on a malformed GraphQL response (no data, no errors)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {})));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError on a response shaped correctly except customers.edges/pageInfo is missing', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: { customers: {} } })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError and never calls fetch for a stored shopDomain outside myshopify.com — SSRF guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCustomers({ shopDomain: 'evil.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('always fetches this shop\'s own fixed GraphQL endpoint regardless of the cursor value — the cursor is an opaque variable, never a URL, so there is no host to spoof', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlCustomersResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await adapter.fetchCustomers({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, 'https://attacker.example/steal');

      expect(fetchMock.mock.calls[0][0]).toBe('https://acme.myshopify.com/admin/api/2024-10/graphql.json');
    });
  });

  describe('fetchProducts() — GraphQL', () => {
    function variantNode(overrides: Partial<{ id: string; sku: string | null; price: string | null; inventoryQuantity: number | null; updatedAt: string }> = {}) {
      return { id: 'gid://shopify/ProductVariant/901', sku: 'TEE-S', price: '19.99', inventoryQuantity: 10, updatedAt: '2026-01-02T00:00:00Z', ...overrides };
    }

    function productNode(
      overrides: Partial<{ id: string; title: string; updatedAt: string }> = {},
      variantNodes: ReturnType<typeof variantNode>[] = [variantNode()],
      variantsPageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
    ) {
      return {
        id: 'gid://shopify/Product/55',
        title: 'Classic Tee',
        updatedAt: '2026-01-01T00:00:00Z',
        ...overrides,
        variants: { edges: variantNodes.map((node) => ({ node })), pageInfo: variantsPageInfo },
      };
    }

    function graphqlProductsResponse(
      nodes: ReturnType<typeof productNode>[],
      pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
    ) {
      return jsonResponse(200, { data: { products: { edges: nodes.map((node) => ({ node })), pageInfo } } });
    }

    function graphqlVariantContinuationResponse(
      nodes: ReturnType<typeof variantNode>[],
      pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
    ) {
      return jsonResponse(200, { data: { product: { variants: { edges: nodes.map((node) => ({ node })), pageInfo } } } });
    }

    it('requests the first page over GraphQL and normalizes products with variants (product + variant GID -> numeric externalId)', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlProductsResponse([productNode()]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page).toEqual({
        products: [
          {
            externalId: '55',
            title: 'Classic Tee',
            sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
            variants: [
              { externalId: '901', sku: 'TEE-S', price: '19.99', inventoryQuantity: 10, sourceUpdatedAt: new Date('2026-01-02T00:00:00Z') },
            ],
          },
        ],
        nextCursor: null,
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://acme.myshopify.com/admin/api/2024-10/graphql.json');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_123');
    });

    it('requests only the product/variant fields normalizeProduct() consumes', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlProductsResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      const sentBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { query: string };
      for (const field of ['title', 'updatedAt', 'sku', 'price', 'inventoryQuantity']) {
        expect(sentBody.query).toContain(field);
      }
      expect(sentBody.query).not.toContain('handle');
      expect(sentBody.query).not.toContain('vendor');
      expect(sentBody.query).not.toContain('status');
    });

    it('returns endCursor as nextCursor when the products connection hasNextPage is true', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => graphqlProductsResponse([], { hasNextPage: true, endCursor: 'productsCursorA' })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.nextCursor).toBe('productsCursorA');
    });

    it('sends the prior products-page cursor as the "after" variable on a subsequent page', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlProductsResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, 'productsCursorA');

      const sentBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { variables: Record<string, unknown> };
      expect(sentBody.variables).toMatchObject({ after: 'productsCursorA' });
    });

    it('sends options.updatedAtMin as the "query" variable on every products page', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlProductsResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
      const options = { updatedAtMin: new Date('2026-01-01T00:00:00.000Z') };

      await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, undefined, options);
      await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, 'productsCursorA', options);

      const firstBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { variables: Record<string, unknown> };
      const secondBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string) as { variables: Record<string, unknown> };
      expect(firstBody.variables).toMatchObject({ query: "updated_at:>='2026-01-01T00:00:00.000Z'" });
      expect(secondBody.variables).toMatchObject({ after: 'productsCursorA', query: "updated_at:>='2026-01-01T00:00:00.000Z'" });
    });

    it('handles a product with zero variants', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => graphqlProductsResponse([productNode({}, [])])));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.products[0].variants).toEqual([]);
    });

    it('walks a second variants page for a product whose variants connection has hasNextPage: true, using the variant connection\'s own cursor (not the products cursor)', async () => {
      const fetchMock = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(
          graphqlProductsResponse([
            productNode({}, [variantNode({ id: 'gid://shopify/ProductVariant/901' })], { hasNextPage: true, endCursor: 'variantsCursor1' }),
          ]),
        )
        .mockResolvedValueOnce(
          graphqlVariantContinuationResponse([variantNode({ id: 'gid://shopify/ProductVariant/902', sku: 'TEE-M' })], {
            hasNextPage: false,
            endCursor: null,
          }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.products[0].variants.map((v) => v.externalId)).toEqual(['901', '902']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const continuationBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string) as { variables: Record<string, unknown> };
      expect(continuationBody.variables).toEqual({ id: 'gid://shopify/Product/55', first: 250, after: 'variantsCursor1' });
    });

    it('keeps walking variant pages across three pages until hasNextPage is false', async () => {
      const fetchMock = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(
          graphqlProductsResponse([
            productNode({}, [variantNode({ id: 'gid://shopify/ProductVariant/901' })], { hasNextPage: true, endCursor: 'cursor1' }),
          ]),
        )
        .mockResolvedValueOnce(
          graphqlVariantContinuationResponse([variantNode({ id: 'gid://shopify/ProductVariant/902' })], { hasNextPage: true, endCursor: 'cursor2' }),
        )
        .mockResolvedValueOnce(
          graphqlVariantContinuationResponse([variantNode({ id: 'gid://shopify/ProductVariant/903' })], { hasNextPage: false, endCursor: null }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.products[0].variants.map((v) => v.externalId)).toEqual(['901', '902', '903']);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('independently paginates variants for multiple products on the same products page without mixing their variants', async () => {
      const fetchMock = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(
          graphqlProductsResponse([
            productNode(
              { id: 'gid://shopify/Product/55', title: 'Product A' },
              [variantNode({ id: 'gid://shopify/ProductVariant/901' })],
              { hasNextPage: false, endCursor: null },
            ),
            productNode(
              { id: 'gid://shopify/Product/66', title: 'Product B' },
              [variantNode({ id: 'gid://shopify/ProductVariant/911' })],
              { hasNextPage: true, endCursor: 'bCursor1' },
            ),
          ]),
        )
        .mockResolvedValueOnce(
          graphqlVariantContinuationResponse([variantNode({ id: 'gid://shopify/ProductVariant/912' })], { hasNextPage: false, endCursor: null }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.products[0].variants.map((v) => v.externalId)).toEqual(['901']);
      expect(page.products[1].variants.map((v) => v.externalId)).toEqual(['911', '912']);
      const continuationBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string) as { variables: Record<string, unknown> };
      expect(continuationBody.variables).toMatchObject({ id: 'gid://shopify/Product/66' });
    });

    it('throws ProviderError on a non-2xx response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError when the network request itself fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        }),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchProducts({ shopDomain: 'bad.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError on an HTTP 200 response carrying a GraphQL errors[] body', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { errors: [{ message: 'Throttled' }] })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError on a malformed products connection (no data, no errors)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {})));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError when a product\'s embedded variants connection is malformed, rather than silently producing incomplete variant data', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(200, { data: { products: { edges: [{ node: { id: 'gid://shopify/Product/55', title: 'Classic Tee', updatedAt: '2026-01-01T00:00:00Z' } }], pageInfo: { hasNextPage: false, endCursor: null } } } }),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError when a variant continuation response is malformed, rather than silently truncating the variant list', async () => {
      const fetchMock = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(
          graphqlProductsResponse([productNode({}, [variantNode()], { hasNextPage: true, endCursor: 'cursor1' })]),
        )
        .mockResolvedValueOnce(jsonResponse(200, { data: { product: {} } }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchProducts({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError and never calls fetch for a stored shopDomain outside myshopify.com — SSRF guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchProducts({ shopDomain: 'evil.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('fetchOrders() — GraphQL', () => {
    function moneyBag(amount: string) {
      return { shopMoney: { amount } };
    }

    function lineItemNode(overrides: Record<string, unknown> = {}) {
      return {
        id: 'gid://shopify/LineItem/9001',
        quantity: 2,
        variant: { id: 'gid://shopify/ProductVariant/901' },
        originalUnitPriceSet: moneyBag('9.99'),
        ...overrides,
      };
    }

    function refundNode(
      overrides: Record<string, unknown> = {},
      refundLineItemNodes: Record<string, unknown>[] = [],
      transactions: { status: string; amountSet: ReturnType<typeof moneyBag> | null }[] = [],
    ) {
      return {
        id: 'gid://shopify/Refund/9500',
        note: 'Damaged item',
        createdAt: '2026-01-02T00:00:00Z',
        refundLineItems: { edges: refundLineItemNodes.map((node) => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } },
        transactions,
        ...overrides,
      };
    }

    function fulfillmentNode(overrides: Record<string, unknown> = {}) {
      return {
        id: 'gid://shopify/Fulfillment/7001',
        status: 'SUCCESS',
        shipmentStatus: 'IN_TRANSIT',
        updatedAt: '2026-01-03T00:00:00Z',
        trackingInfo: { company: 'UPS', number: '1Z999', url: 'https://ups.com/track/1Z999' },
        ...overrides,
      };
    }

    function orderNode(
      overrides: Record<string, unknown> = {},
      lineItemNodes: Record<string, unknown>[] = [lineItemNode()],
      lineItemsPageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
      refunds: Record<string, unknown>[] = [],
      fulfillments: Record<string, unknown>[] = [],
    ) {
      return {
        id: 'gid://shopify/Order/900',
        customer: { id: 'gid://shopify/Customer/1' },
        totalPriceSet: moneyBag('19.99'),
        updatedAt: '2026-01-01T00:00:00Z',
        ...overrides,
        lineItems: { edges: lineItemNodes.map((node) => ({ node })), pageInfo: lineItemsPageInfo },
        refunds,
        fulfillments,
      };
    }

    function graphqlOrdersResponse(
      nodes: ReturnType<typeof orderNode>[],
      pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
    ) {
      return jsonResponse(200, { data: { orders: { edges: nodes.map((node) => ({ node })), pageInfo } } });
    }

    function graphqlOrderLineItemsContinuationResponse(
      nodes: Record<string, unknown>[],
      pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
    ) {
      return jsonResponse(200, { data: { order: { lineItems: { edges: nodes.map((node) => ({ node })), pageInfo } } } });
    }

    it('requests the first page over GraphQL and normalizes orders with line items (order/variant GID -> numeric externalId, money unwrapped)', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlOrdersResponse([orderNode()]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

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
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://acme.myshopify.com/admin/api/2024-10/graphql.json');
      expect(init?.method).toBe('POST');
      // No nested { shopMoney: { amount } } object anywhere in the normalized order — money is fully unwrapped.
      expect(JSON.stringify(page)).not.toContain('shopMoney');
    });

    it('requests only the order/line-item fields normalizeOrder() consumes, with no order-level status field', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlOrdersResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      const sentBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { query: string };
      for (const field of ['totalPriceSet', 'originalUnitPriceSet', 'quantity']) {
        expect(sentBody.query).toContain(field);
      }
      expect(sentBody.query).not.toContain('financialStatus');
      expect(sentBody.query).not.toContain('displayFulfillmentStatus');
      expect(sentBody.query).not.toContain('name');
    });

    it('normalizes a null customer (guest checkout) and a null variant (custom line) to null', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          graphqlOrdersResponse([
            orderNode({ id: 'gid://shopify/Order/901', customer: null, totalPriceSet: moneyBag('5.00') }, [
              lineItemNode({ id: 'gid://shopify/LineItem/9002', variant: null, quantity: 1, originalUnitPriceSet: moneyBag('5.00') }),
            ]),
          ]),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.orders[0].customerExternalId).toBeNull();
      expect(page.orders[0].lineItems[0].variantExternalId).toBeNull();
    });

    it('returns endCursor as nextCursor when the orders connection hasNextPage is true', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => graphqlOrdersResponse([], { hasNextPage: true, endCursor: 'ordersCursorA' })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.nextCursor).toBe('ordersCursorA');
    });

    it('sends the prior orders-page cursor as the "after" variable on a subsequent page', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlOrdersResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, 'ordersCursorA');

      const sentBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { variables: Record<string, unknown> };
      expect(sentBody.variables).toMatchObject({ after: 'ordersCursorA' });
    });

    it('sends options.updatedAtMin as the "query" variable on every orders page', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlOrdersResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
      const options = { updatedAtMin: new Date('2026-01-01T00:00:00.000Z') };

      await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, undefined, options);
      await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, 'ordersCursorA', options);

      const firstBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { variables: Record<string, unknown> };
      const secondBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string) as { variables: Record<string, unknown> };
      expect(firstBody.variables).toMatchObject({ query: "updated_at:>='2026-01-01T00:00:00.000Z'" });
      expect(secondBody.variables).toMatchObject({ after: 'ordersCursorA', query: "updated_at:>='2026-01-01T00:00:00.000Z'" });
    });

    it('handles an order with no line items', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => graphqlOrdersResponse([orderNode({}, [])])));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.orders[0].lineItems).toEqual([]);
    });

    it('walks a second line-items page for an order whose line-items connection has hasNextPage: true, using the line-items connection\'s own cursor (not the orders cursor)', async () => {
      const fetchMock = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(
          graphqlOrdersResponse([orderNode({}, [lineItemNode({ id: 'gid://shopify/LineItem/9001' })], { hasNextPage: true, endCursor: 'liCursor1' })]),
        )
        .mockResolvedValueOnce(
          graphqlOrderLineItemsContinuationResponse([lineItemNode({ id: 'gid://shopify/LineItem/9002' })], { hasNextPage: false, endCursor: null }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.orders[0].lineItems.map((li) => li.externalId)).toEqual(['9001', '9002']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const continuationBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string) as { variables: Record<string, unknown> };
      expect(continuationBody.variables).toEqual({ id: 'gid://shopify/Order/900', first: 250, after: 'liCursor1' });
    });

    it('independently paginates line items for multiple orders on the same orders page without cross-contaminating cursors', async () => {
      const fetchMock = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(
          graphqlOrdersResponse([
            orderNode({ id: 'gid://shopify/Order/900' }, [lineItemNode({ id: 'gid://shopify/LineItem/9001' })], { hasNextPage: false, endCursor: null }),
            orderNode({ id: 'gid://shopify/Order/901' }, [lineItemNode({ id: 'gid://shopify/LineItem/9101' })], { hasNextPage: true, endCursor: 'bCursor1' }),
          ]),
        )
        .mockResolvedValueOnce(
          graphqlOrderLineItemsContinuationResponse([lineItemNode({ id: 'gid://shopify/LineItem/9102' })], { hasNextPage: false, endCursor: null }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.orders[0].lineItems.map((li) => li.externalId)).toEqual(['9001']);
      expect(page.orders[1].lineItems.map((li) => li.externalId)).toEqual(['9101', '9102']);
      const continuationBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string) as { variables: Record<string, unknown> };
      expect(continuationBody.variables).toMatchObject({ id: 'gid://shopify/Order/901' });
    });

    it("normalizes an order's embedded refunds, summing only successful transaction amounts (GraphQL SUCCESS/PENDING enums lower-cased)", async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          graphqlOrdersResponse([
            orderNode(
              {},
              [lineItemNode()],
              { hasNextPage: false, endCursor: null },
              [
                refundNode({}, [{ id: 'gid://shopify/RefundLineItem/9501', quantity: 1, lineItem: { id: 'gid://shopify/LineItem/9001' } }], [
                  { status: 'SUCCESS', amountSet: moneyBag('9.99') },
                  { status: 'PENDING', amountSet: moneyBag('9.99') },
                ]),
              ],
            ),
          ]),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

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

    it('normalizes an order with an empty refunds list to an empty refunds array', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => graphqlOrdersResponse([orderNode({ customer: null, totalPriceSet: moneyBag('5.00') }, [])])));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.orders[0].refunds).toEqual([]);
      expect(page.orders[0].fulfillments).toEqual([]);
    });

    it(
      'requests refunds/fulfillments with a generous "first" and issues no continuation request for them — Order.refunds/Order.fulfillments are plain lists in Shopify\'s real schema, not connections, so there is no cursor to continue from',
      async () => {
        const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
          graphqlOrdersResponse([orderNode({}, [], { hasNextPage: false, endCursor: null }, [refundNode()], [fulfillmentNode()])]),
        );
        vi.stubGlobal('fetch', fetchMock);
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

        await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const sentBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { variables: Record<string, unknown> };
        expect(sentBody.variables).toMatchObject({ refundsFirst: 250, fulfillmentsFirst: 250 });
      },
    );

    it("normalizes an order's embedded fulfillments (GraphQL SUCCESS/IN_TRANSIT enums lower-cased, singular trackingInfo mapped to REST's flat fields)", async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => graphqlOrdersResponse([orderNode({}, [], { hasNextPage: false, endCursor: null }, [], [fulfillmentNode()])])),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

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

    it('maps a fulfillment with no trackingInfo to null tracking fields', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          graphqlOrdersResponse([orderNode({}, [], { hasNextPage: false, endCursor: null }, [], [fulfillmentNode({ trackingInfo: null })])]),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.orders[0].fulfillments[0]).toMatchObject({ trackingCompany: null, trackingNumber: null, trackingUrl: null });
    });

    it('throws ProviderError on a non-2xx response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError when the network request itself fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        }),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchOrders({ shopDomain: 'bad.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError on an HTTP 200 response carrying a GraphQL errors[] body', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { errors: [{ message: 'Throttled' }] })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError on a malformed orders connection (no data, no errors)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {})));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it("throws ProviderError when an order's embedded line-items connection is malformed, rather than silently producing incomplete data", async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(200, {
            data: {
              orders: {
                edges: [{ node: { id: 'gid://shopify/Order/900', customer: null, totalPriceSet: moneyBag('5.00'), updatedAt: '2026-01-01T00:00:00Z', refunds: [], fulfillments: [] } }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it("throws ProviderError when an order's refunds field is malformed (not an array)", async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(200, {
            data: {
              orders: {
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/Order/900',
                      customer: null,
                      totalPriceSet: moneyBag('5.00'),
                      updatedAt: '2026-01-01T00:00:00Z',
                      lineItems: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
                      refunds: null,
                      fulfillments: [],
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError when a refund\'s nested refundLineItems/transactions shape is malformed', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          graphqlOrdersResponse([orderNode({}, [], { hasNextPage: false, endCursor: null }, [{ id: 'gid://shopify/Refund/9500', note: null, createdAt: '2026-01-02T00:00:00Z' }])]),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it("throws ProviderError when an order's fulfillments field is malformed (not an array)", async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          jsonResponse(200, {
            data: {
              orders: {
                edges: [
                  {
                    node: {
                      id: 'gid://shopify/Order/900',
                      customer: null,
                      totalPriceSet: moneyBag('5.00'),
                      updatedAt: '2026-01-01T00:00:00Z',
                      lineItems: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
                      refunds: [],
                      fulfillments: null,
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
        ),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError when a line-items continuation response is malformed, rather than silently truncating the line-item list', async () => {
      const fetchMock = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(graphqlOrdersResponse([orderNode({}, [lineItemNode()], { hasNextPage: true, endCursor: 'liCursor1' })]))
        .mockResolvedValueOnce(jsonResponse(200, { data: { order: {} } }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchOrders({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError and never calls fetch for a stored shopDomain outside myshopify.com — SSRF guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchOrders({ shopDomain: 'evil.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('verifyWebhookSignature()', () => {
    it('returns true for a correctly signed body', () => {
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
      const rawBody = '{"id":1}';
      const signature = sign(rawBody, 'shhh');

      expect(adapter.verifyWebhookSignature(rawBody, { 'x-shopify-hmac-sha256': signature }, 'shhh')).toBe(true);
    });

    it('returns false when the signature does not match', () => {
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      expect(
        adapter.verifyWebhookSignature('{"id":1}', { 'x-shopify-hmac-sha256': 'bogus==' }, 'shhh'),
      ).toBe(false);
    });

    it('returns false when the body was tampered with after signing', () => {
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
      const signature = sign('{"id":1}', 'shhh');

      expect(
        adapter.verifyWebhookSignature('{"id":2}', { 'x-shopify-hmac-sha256': signature }, 'shhh'),
      ).toBe(false);
    });

    it('returns false when the signature header is missing', () => {
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      expect(adapter.verifyWebhookSignature('{"id":1}', {}, 'shhh')).toBe(false);
    });
  });

  describe('fetchCollections() — GraphQL', () => {
    function graphqlCollectionsResponse(
      nodes: { id: string; title: string; updatedAt: string }[],
      pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
    ) {
      return jsonResponse(200, { data: { collections: { edges: nodes.map((node) => ({ node })), pageInfo } } });
    }

    it('fetches the unified GraphQL collections connection and normalizes the shape (GID -> plain numeric externalId)', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
        graphqlCollectionsResponse([{ id: 'gid://shopify/Collection/10', title: 'Summer Sale', updatedAt: '2026-01-01T00:00:00Z' }]),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page).toEqual({
        collections: [{ externalId: '10', title: 'Summer Sale', sourceUpdatedAt: new Date('2026-01-01T00:00:00Z') }],
        nextCursor: null,
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://acme.myshopify.com/admin/api/2024-10/graphql.json');
      expect(init?.method).toBe('POST');
      const sentBody = JSON.parse(init?.body as string) as { query: string; variables: Record<string, unknown> };
      expect(sentBody.query).toContain('collections(first: $first, after: $after, query: $query)');
      expect(sentBody.variables).toEqual({ first: 250 });
    });

    it('normalizes both a formerly-custom and a formerly-smart collection identically — GraphQL has one unified type, no kind field is invented', async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        graphqlCollectionsResponse([
          { id: 'gid://shopify/Collection/10', title: 'Summer Sale (was custom)', updatedAt: '2026-01-01T00:00:00Z' },
          { id: 'gid://shopify/Collection/20', title: 'Best Sellers (was smart)', updatedAt: '2026-01-02T00:00:00Z' },
        ]),
      ));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.collections).toEqual([
        { externalId: '10', title: 'Summer Sale (was custom)', sourceUpdatedAt: new Date('2026-01-01T00:00:00Z') },
        { externalId: '20', title: 'Best Sellers (was smart)', sourceUpdatedAt: new Date('2026-01-02T00:00:00Z') },
      ]);
      expect(Object.keys(page.collections[0])).not.toContain('type');
      expect(Object.keys(page.collections[0])).not.toContain('kind');
    });

    it('returns endCursor as nextCursor when hasNextPage is true', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => graphqlCollectionsResponse([], { hasNextPage: true, endCursor: 'cursorA' })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page.nextCursor).toBe('cursorA');
    });

    it('sends the prior page cursor as the "after" variable on a subsequent page', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlCollectionsResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, 'cursorA');

      const sentBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { variables: Record<string, unknown> };
      expect(sentBody.variables).toEqual({ first: 250, after: 'cursorA' });
    });

    it('requests only id, title, and updatedAt — exactly what normalizeCollection() consumes', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlCollectionsResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      const sentBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { query: string };
      expect(sentBody.query).toContain('id');
      expect(sentBody.query).toContain('title');
      expect(sentBody.query).toContain('updatedAt');
    });

    it('sends options.updatedAtMin as the "query" variable on every page (GraphQL cursors do not carry a search filter forward)', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => graphqlCollectionsResponse([]));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
      const options = { updatedAtMin: new Date('2026-01-01T00:00:00.000Z') };

      await adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, undefined, options);
      await adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, 'cursorA', options);

      const firstBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { variables: Record<string, unknown> };
      const secondBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string) as { variables: Record<string, unknown> };
      expect(firstBody.variables).toEqual({ first: 250, query: "updated_at:>='2026-01-01T00:00:00.000Z'" });
      expect(secondBody.variables).toEqual({ first: 250, after: 'cursorA', query: "updated_at:>='2026-01-01T00:00:00.000Z'" });
    });

    it('returns an empty collection list for an empty connection', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => graphqlCollectionsResponse([])));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page).toEqual({ collections: [], nextCursor: null });
    });

    it('throws ProviderError on a non-2xx response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError when the network request itself fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        }),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollections({ shopDomain: 'bad.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError on an HTTP 200 response carrying a GraphQL errors[] body', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { errors: [{ message: 'Throttled' }] })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError on a malformed GraphQL response (no data, no errors)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {})));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError when collections.edges/pageInfo is missing from an otherwise-200 response', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { data: { collections: {} } })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollections({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('throws ProviderError and never calls fetch for a stored shopDomain outside myshopify.com — SSRF guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollections({ shopDomain: 'evil.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('fetchCollects() — GraphQL compound-cursor traversal', () => {
    function decodeCursor(cursor: string) {
      return JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as {
        collectionsCursor: string | null;
        collectionsExhausted: boolean;
        currentCollectionId: string | null;
        productsCursor: string | null;
      };
    }

    function encodeCursor(state: {
      collectionsCursor: string | null;
      collectionsExhausted: boolean;
      currentCollectionId: string | null;
      productsCursor: string | null;
    }) {
      return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
    }

    function nextCollectionResponse(
      nodes: { id: string }[],
      pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
    ) {
      return jsonResponse(200, { data: { collections: { edges: nodes.map((node) => ({ node })), pageInfo } } });
    }

    function collectionProductsResponse(
      nodes: { id: string }[],
      pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null },
    ) {
      return jsonResponse(200, { data: { collection: { products: { edges: nodes.map((node) => ({ node })), pageInfo } } } });
    }

    it('(1) fetches a single collection with multiple product pages, resuming with the products connection\'s own cursor', async () => {
      const fetchMock = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(nextCollectionResponse([{ id: 'gid://shopify/Collection/10' }], { hasNextPage: false, endCursor: null }))
        .mockResolvedValueOnce(
          collectionProductsResponse([{ id: 'gid://shopify/Product/55' }], { hasNextPage: true, endCursor: 'prodCursor1' }),
        );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page1 = await adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page1.collects).toEqual([{ externalId: '10:55', collectionExternalId: '10', productExternalId: '55' }]);
      expect(page1.nextCursor).not.toBeNull();
      expect(decodeCursor(page1.nextCursor!)).toEqual({
        collectionsCursor: null,
        collectionsExhausted: true,
        currentCollectionId: 'gid://shopify/Collection/10',
        productsCursor: 'prodCursor1',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      fetchMock.mockResolvedValueOnce(collectionProductsResponse([{ id: 'gid://shopify/Product/56' }], { hasNextPage: false, endCursor: null }));
      const page2 = await adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, page1.nextCursor!);

      expect(page2.collects).toEqual([{ externalId: '10:56', collectionExternalId: '10', productExternalId: '56' }]);
      expect(page2.nextCursor).toBeNull(); // (7) final page returns null cursor
      expect(fetchMock).toHaveBeenCalledTimes(3); // resuming mid-collection does NOT re-issue an advance-collection request
      const continuationVariables = JSON.parse(fetchMock.mock.calls[2][1]?.body as string) as { variables: Record<string, unknown> };
      expect(continuationVariables.variables).toEqual({ id: 'gid://shopify/Collection/10', first: 250, after: 'prodCursor1' });
    });

    it('(2)(4) walks multiple collections, each with multiple product pages, transitioning without skipping/duplicating', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      // Call 1: advance to collection A, fetch its only (complete) products page.
      fetchMock
        .mockResolvedValueOnce(nextCollectionResponse([{ id: 'gid://shopify/Collection/10' }], { hasNextPage: true, endCursor: 'collCursorA' }))
        .mockResolvedValueOnce(collectionProductsResponse([{ id: 'gid://shopify/Product/55' }], { hasNextPage: false, endCursor: null }));
      const page1 = await adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });
      expect(page1.collects).toEqual([{ externalId: '10:55', collectionExternalId: '10', productExternalId: '55' }]);
      expect(decodeCursor(page1.nextCursor!)).toEqual({
        collectionsCursor: 'collCursorA',
        collectionsExhausted: false,
        currentCollectionId: null,
        productsCursor: null,
      });

      // Call 2: advance to collection B (last one), fetch its first (incomplete) products page.
      fetchMock
        .mockResolvedValueOnce(nextCollectionResponse([{ id: 'gid://shopify/Collection/20' }], { hasNextPage: false, endCursor: null }))
        .mockResolvedValueOnce(
          collectionProductsResponse([{ id: 'gid://shopify/Product/900' }], { hasNextPage: true, endCursor: 'bProdCursor1' }),
        );
      const page2 = await adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, page1.nextCursor!);
      expect(page2.collects).toEqual([{ externalId: '20:900', collectionExternalId: '20', productExternalId: '900' }]);
      const cursor2 = decodeCursor(page2.nextCursor!);
      expect(cursor2).toEqual({
        collectionsCursor: null,
        collectionsExhausted: true,
        currentCollectionId: 'gid://shopify/Collection/20',
        productsCursor: 'bProdCursor1',
      });
      // The advance-to-B call must use collection A's own forward cursor, not restart from the beginning.
      const advanceToBVariables = JSON.parse(fetchMock.mock.calls[2][1]?.body as string) as { variables: Record<string, unknown> };
      expect(advanceToBVariables.variables).toEqual({ first: 1, after: 'collCursorA' });

      // Call 3: finish collection B's products — no more collections after it.
      fetchMock.mockResolvedValueOnce(collectionProductsResponse([{ id: 'gid://shopify/Product/901' }], { hasNextPage: false, endCursor: null }));
      const page3 = await adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, page2.nextCursor!);
      expect(page3.collects).toEqual([{ externalId: '20:901', collectionExternalId: '20', productExternalId: '901' }]);
      expect(page3.nextCursor).toBeNull();
      // No collections query was re-issued — collectionsExhausted:true short-circuited straight to "done".
      expect(fetchMock).toHaveBeenCalledTimes(5);
    });

    it('(3) resumes correctly from a cursor encoded mid-collection (does not restart that collection\'s products from the beginning)', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
        collectionProductsResponse([{ id: 'gid://shopify/Product/56' }], { hasNextPage: false, endCursor: null }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
      const midCursor = encodeCursor({
        collectionsCursor: null,
        collectionsExhausted: true,
        currentCollectionId: 'gid://shopify/Collection/10',
        productsCursor: 'prodCursor1',
      });

      const page = await adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, midCursor);

      expect(fetchMock).toHaveBeenCalledTimes(1); // no "advance collection" call — resumes the same collection directly
      const sentBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { variables: Record<string, unknown> };
      expect(sentBody.variables).toEqual({ id: 'gid://shopify/Collection/10', first: 250, after: 'prodCursor1' });
      expect(page.collects).toEqual([{ externalId: '10:56', collectionExternalId: '10', productExternalId: '56' }]);
    });

    it('(5) handles an empty collection (zero products) — returns an empty collects page, not an error', async () => {
      const fetchMock = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(nextCollectionResponse([{ id: 'gid://shopify/Collection/10' }], { hasNextPage: false, endCursor: null }))
        .mockResolvedValueOnce(collectionProductsResponse([], { hasNextPage: false, endCursor: null }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page).toEqual({ collects: [], nextCursor: null });
    });

    it('(6) walks multiple collections where some are empty, without losing the non-empty ones', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      // Collection A: empty.
      fetchMock
        .mockResolvedValueOnce(nextCollectionResponse([{ id: 'gid://shopify/Collection/10' }], { hasNextPage: true, endCursor: 'collCursorA' }))
        .mockResolvedValueOnce(collectionProductsResponse([], { hasNextPage: false, endCursor: null }));
      const page1 = await adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });
      expect(page1.collects).toEqual([]);
      expect(page1.nextCursor).not.toBeNull();

      // Collection B: one product, last collection.
      fetchMock
        .mockResolvedValueOnce(nextCollectionResponse([{ id: 'gid://shopify/Collection/20' }], { hasNextPage: false, endCursor: null }))
        .mockResolvedValueOnce(collectionProductsResponse([{ id: 'gid://shopify/Product/900' }], { hasNextPage: false, endCursor: null }));
      const page2 = await adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, page1.nextCursor!);
      expect(page2.collects).toEqual([{ externalId: '20:900', collectionExternalId: '20', productExternalId: '900' }]);
      expect(page2.nextCursor).toBeNull(); // (7) final page returns null cursor
    });

    it('(8)(9) synthesizes a deterministic "${collectionId}:${productId}" externalId — the same real pair always produces the same externalId', async () => {
      const fetchMock = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(nextCollectionResponse([{ id: 'gid://shopify/Collection/10' }], { hasNextPage: false, endCursor: null }))
        .mockResolvedValueOnce(collectionProductsResponse([{ id: 'gid://shopify/Product/55' }], { hasNextPage: false, endCursor: null }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter1 = new ShopifyAdapter(makeRegistry(), makeConfig());
      const page1 = await adapter1.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      fetchMock
        .mockResolvedValueOnce(nextCollectionResponse([{ id: 'gid://shopify/Collection/10' }], { hasNextPage: false, endCursor: null }))
        .mockResolvedValueOnce(collectionProductsResponse([{ id: 'gid://shopify/Product/55' }], { hasNextPage: false, endCursor: null }));
      const adapter2 = new ShopifyAdapter(makeRegistry(), makeConfig());
      const page2 = await adapter2.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page1.collects[0].externalId).toBe('10:55');
      expect(page2.collects[0].externalId).toBe(page1.collects[0].externalId);
    });

    it('(10) fails safely (throws ProviderError) on a malformed/invalid compound cursor, rather than producing incorrect traversal', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, 'not-valid-base64-json!!!'),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      await expect(
        adapter.fetchCollects(
          { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' },
          Buffer.from(JSON.stringify({ wrong: 'shape' }), 'utf8').toString('base64'),
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      await expect(
        adapter.fetchCollects(
          { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' },
          Buffer.from(
            JSON.stringify({ collectionsCursor: 123, collectionsExhausted: false, currentCollectionId: null, productsCursor: null }),
            'utf8',
          ).toString('base64'),
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('(11) the cursor never alters the fixed Shopify GraphQL endpoint — it is decoded into request variables, not a URL', async () => {
      const fetchMock = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(collectionProductsResponse([], { hasNextPage: false, endCursor: null }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
      const cursor = encodeCursor({
        collectionsCursor: null,
        collectionsExhausted: true,
        currentCollectionId: 'gid://shopify/Collection/10',
        productsCursor: 'https://attacker.example/steal',
      });

      await adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }, cursor);

      expect(fetchMock.mock.calls[0][0]).toBe('https://acme.myshopify.com/admin/api/2024-10/graphql.json');
    });

    it('throws ProviderError and never calls fetch for a stored shopDomain outside myshopify.com — SSRF guard', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollects({ shopDomain: 'evil.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('(12) throws ProviderError on a non-2xx response while advancing to the next collection', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'bad' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('(12) throws ProviderError when the network request itself fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new Error('getaddrinfo ENOTFOUND');
        }),
      );
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollects({ shopDomain: 'bad.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('(12) throws ProviderError on an HTTP 200 response carrying a GraphQL errors[] body', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { errors: [{ message: 'Throttled' }] })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('(12) throws ProviderError on a malformed "next collection" response (no data, no errors)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {})));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('(12) throws ProviderError on a malformed "collection products" response', async () => {
      const fetchMock = vi
        .fn<(url: string, init?: RequestInit) => Promise<Response>>()
        .mockResolvedValueOnce(nextCollectionResponse([{ id: 'gid://shopify/Collection/10' }], { hasNextPage: false, endCursor: null }))
        .mockResolvedValueOnce(jsonResponse(200, { data: { collection: {} } }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' }),
      ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    });

    it('returns no collects and a null cursor when the shop has zero collections at all', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => nextCollectionResponse([], { hasNextPage: false, endCursor: null })));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const page = await adapter.fetchCollects({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_123' });

      expect(page).toEqual({ collects: [], nextCursor: null });
    });
  });

  describe('parseWebhookEvent()', () => {
    it('normalizes a customers/update delivery, using the X-Shopify-Webhook-Id header as the dedupe key', () => {
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
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
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
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
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
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
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
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
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
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
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
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
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
      const rawBody = JSON.stringify({ id: 11, title: 'Best Sellers', updated_at: '2026-01-02T00:00:00Z' });

      const result = adapter.parseWebhookEvent(rawBody, {
        'x-shopify-topic': 'collections/update',
        'x-shopify-webhook-id': 'wh_evt_7',
      });

      expect(result?.payload).toMatchObject({ resource: 'collection', data: { externalId: '11', title: 'Best Sellers' } });
    });

    it('returns null for an unrecognized topic (e.g. a delete event) — doc 21 "process only relevant events"', () => {
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const result = adapter.parseWebhookEvent('{}', { 'x-shopify-topic': 'customers/delete' });

      expect(result).toBeNull();
    });

    it('returns null when the topic header is missing entirely', () => {
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      expect(adapter.parseWebhookEvent('{}', {})).toBeNull();
    });

    it('returns null for unparseable JSON', () => {
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      expect(adapter.parseWebhookEvent('not json', { 'x-shopify-topic': 'customers/update' })).toBeNull();
    });

    it('derives a stable fallback event id when X-Shopify-Webhook-Id is absent', () => {
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
      const rawBody = JSON.stringify({ id: 1, email: null, first_name: null, last_name: null, phone: null, updated_at: '2026-01-01T00:00:00Z' });

      const first = adapter.parseWebhookEvent(rawBody, { 'x-shopify-topic': 'customers/update' });
      const second = adapter.parseWebhookEvent(rawBody, { 'x-shopify-topic': 'customers/update' });

      expect(first?.externalEventId).toBeTruthy();
      expect(first?.externalEventId).toBe(second?.externalEventId);
    });
  });

  describe('refreshCredentials()', () => {
    it('returns null for credentials without the client_credentials grantType (e.g. authorization-code/manual tokens)', async () => {
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      const result = await adapter.refreshCredentials({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_x' });

      expect(result).toBeNull();
    });

    it('re-mints a token and returns fresh credentials for a client_credentials grant', async () => {
      const fetchMock = vi.fn(async () => jsonResponse(200, { access_token: 'shpca_new', expires_in: 86399 }));
      vi.stubGlobal('fetch', fetchMock);
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
      const before = Date.now();

      const result = await adapter.refreshCredentials({
        shopDomain: 'acme.myshopify.com',
        accessToken: 'shpca_old',
        grantType: 'client_credentials',
        expiresAt: new Date(before - 1000).toISOString(),
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://acme.myshopify.com/admin/oauth/access_token',
        expect.objectContaining({
          method: 'POST',
          body: 'grant_type=client_credentials&client_id=client_id&client_secret=client_secret',
        }),
      );
      expect(result?.shopDomain).toBe('acme.myshopify.com');
      expect(result?.accessToken).toBe('shpca_new');
      expect(result?.grantType).toBe('client_credentials');
      expect(new Date(result!.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 86399 * 1000);
    });

    it('throws ProviderError when the app client id/secret are not configured', async () => {
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig({ SHOPIFY_APP_CLIENT_ID: undefined }));

      await expect(
        adapter.refreshCredentials({ shopDomain: 'acme.myshopify.com', accessToken: 'x', grantType: 'client_credentials', expiresAt: new Date().toISOString() }),
      ).rejects.toThrow('Shopify client-credentials refresh is not configured.');
    });

    it('throws ProviderError when Shopify rejects the request', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
      const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

      await expect(
        adapter.refreshCredentials({ shopDomain: 'acme.myshopify.com', accessToken: 'x', grantType: 'client_credentials', expiresAt: new Date().toISOString() }),
      ).rejects.toThrow('Shopify rejected the client credentials request.');
    });

    describe('authorization_code grant (doc 20 Part 28 — expiring offline tokens)', () => {
      const staleCredentials = {
        shopDomain: 'acme.myshopify.com',
        accessToken: 'shpat_old',
        refreshToken: 'shprt_old',
        grantType: 'authorization_code',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };

      it('sends grant_type=refresh_token with client_id/client_secret/refresh_token to /admin/oauth/access_token', async () => {
        const fetchMock = vi.fn(async () =>
          jsonResponse(200, { access_token: 'shpat_new', refresh_token: 'shprt_new', expires_in: 3600 }),
        );
        vi.stubGlobal('fetch', fetchMock);
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

        await adapter.refreshCredentials(staleCredentials);

        expect(fetchMock).toHaveBeenCalledWith(
          'https://acme.myshopify.com/admin/oauth/access_token',
          expect.objectContaining({
            method: 'POST',
            body: 'grant_type=refresh_token&client_id=client_id&client_secret=client_secret&refresh_token=shprt_old',
          }),
        );
      });

      it('persists the NEW access token and the rotated NEW refresh token, and updates expiresAt', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => jsonResponse(200, { access_token: 'shpat_new', refresh_token: 'shprt_new', expires_in: 3600 })),
        );
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());
        const before = Date.now();

        const result = await adapter.refreshCredentials(staleCredentials);

        expect(result).toEqual({
          shopDomain: 'acme.myshopify.com',
          accessToken: 'shpat_new',
          refreshToken: 'shprt_new',
          grantType: 'authorization_code',
          expiresAt: expect.any(String),
        });
        expect(new Date(result!.expiresAt).getTime()).toBeGreaterThanOrEqual(before + 3600 * 1000);
      });

      it('does not carry the old refresh token forward — the rotated one fully replaces it', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn(async () => jsonResponse(200, { access_token: 'shpat_new', refresh_token: 'shprt_new', expires_in: 3600 })),
        );
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

        const result = await adapter.refreshCredentials(staleCredentials);

        expect(result?.refreshToken).toBe('shprt_new');
        expect(result?.refreshToken).not.toBe('shprt_old');
      });

      it('throws (does not return partial data) when Shopify rejects the refresh request — caller must not overwrite existing valid credentials', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

        await expect(adapter.refreshCredentials(staleCredentials)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      });

      it('throws when the refresh response is missing an access or refresh token', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { access_token: 'shpat_new' })));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

        await expect(adapter.refreshCredentials(staleCredentials)).rejects.toThrow(
          'Shopify refresh-token response was missing an access or refresh token.',
        );
      });

      it('throws when the stored credential has no refresh token to use', async () => {
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

        await expect(
          adapter.refreshCredentials({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_old', grantType: 'authorization_code' }),
        ).rejects.toThrow('Shopify authorization-code refresh is not configured.');
      });

      it('throws when the app client id/secret are not configured', async () => {
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig({ SHOPIFY_APP_CLIENT_ID: undefined }));

        await expect(adapter.refreshCredentials(staleCredentials)).rejects.toThrow('Shopify authorization-code refresh is not configured.');
      });

      it('never leaks the old or new refresh token, access token, or client secret through a thrown error message', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401)));
        const adapter = new ShopifyAdapter(makeRegistry(), makeConfig());

        try {
          await adapter.refreshCredentials(staleCredentials);
          throw new Error('expected refreshCredentials to throw');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).not.toContain('shprt_old');
          expect(message).not.toContain('shpat_old');
          expect(message).not.toContain('client_secret');
        }
      });
    });
  });
});
