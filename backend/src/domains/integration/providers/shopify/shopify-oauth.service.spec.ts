import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { ShopifyOAuthService, decodeShopifyCallbackQuery } from './shopify-oauth.service';
import { ConflictError, ValidationError } from '../../../../common/errors/app-error';
import type { Env } from '../../../../config/env.schema';
import type { IntegrationService } from '../../integration.service';
import type { ShopifyAdapter } from './shopify.adapter';
import type { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';

const VALID_KEY = 'a'.repeat(64);
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const SHOP = 'test-store.myshopify.com';

function makeConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const env: Partial<Env> = {
    BRAYN_CREDENTIAL_ENCRYPTION_KEY: VALID_KEY,
    FRONTEND_URL: 'http://localhost:3000',
    BACKEND_URL: 'http://localhost:3001',
    SHOPIFY_APP_CLIENT_ID: CLIENT_ID,
    SHOPIFY_APP_CLIENT_SECRET: CLIENT_SECRET,
    ...overrides,
  };
  return { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
}

function makeLogger(): StructuredLoggerService {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

function makeIntegrationService(overrides: Partial<IntegrationService> = {}): IntegrationService {
  return {
    connect: vi.fn(async () => ({})),
    setCredentials: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as IntegrationService;
}

function makeAdapter(overrides: Partial<ShopifyAdapter> = {}): ShopifyAdapter {
  return { verifyConnection: vi.fn(async () => true), ...overrides } as unknown as ShopifyAdapter;
}

/** Percent-encodes like a real browser would — the raw bytes Shopify's redirect would actually send. */
function toRawQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** Returns both the Nest-style already-decoded `query` object and the raw query string `verifyHmac` now works from — both derived from the same params, so they always agree. */
function signedQuery(overrides: Record<string, string | undefined> = {}): { query: Record<string, string>; rawQuery: string } {
  // Spread after the defaults so an explicit `undefined` override actually deletes that key.
  const merged: Record<string, string | undefined> = { code: 'auth-code', shop: SHOP, timestamp: '1700000000', ...overrides };
  const base = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined)) as Record<string, string>;

  const message = Object.entries(base)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const hmac = createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
  const query = { ...base, hmac };
  return { query, rawQuery: toRawQueryString(query) };
}

describe('ShopifyOAuthService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('buildAuthorizeUrl()', () => {
    it('builds an authorize URL with the exact required scopes, redirect_uri, and an opaque state, plus a session-binding cookie value', () => {
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());

      const result = service.buildAuthorizeUrl('ws_1', SHOP);
      const url = new URL(result.authorizeUrl);

      expect(url.origin + url.pathname).toBe(`https://${SHOP}/admin/oauth/authorize`);
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('scope')).toBe('read_customers,read_orders,read_products');
      expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3001/api/v1/integrations/shopify/oauth/callback');
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(result.cookieValue).toBeTruthy();
      expect(result.cookieMaxAgeSeconds).toBeGreaterThan(0);
    });

    it('rejects a malformed shop domain without building a URL', () => {
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());

      expect(() => service.buildAuthorizeUrl('ws_1', 'not-a-shop-domain')).toThrow(ValidationError);
    });
  });

  describe('decodeShopifyCallbackQuery()', () => {
    it('preserves a literal, unencoded "+" as "+" rather than decoding it as a space', () => {
      expect(decodeShopifyCallbackQuery('host=admin+store')).toEqual({ host: 'admin+store' });
    });

    it('decodes a percent-encoded "%2B" to "+"', () => {
      expect(decodeShopifyCallbackQuery('state=abc%2Bdef')).toEqual({ state: 'abc+def' });
    });

    it('decodes ordinary percent-encoding (e.g. "%3D" to "=", "%2F" to "/")', () => {
      expect(decodeShopifyCallbackQuery('code=xyz%3D%3D&shop=test%2Fstore')).toEqual({ code: 'xyz==', shop: 'test/store' });
    });

    it('throws on malformed percent-encoding rather than silently misparsing it', () => {
      expect(() => decodeShopifyCallbackQuery('bad=100%')).toThrow();
    });

    it('returns an empty object for an empty raw query', () => {
      expect(decodeShopifyCallbackQuery('')).toEqual({});
    });
  });

  describe('handleCallback()', () => {
    function start(service: ShopifyOAuthService, workspaceId = 'ws_1') {
      const { authorizeUrl, cookieValue } = service.buildAuthorizeUrl(workspaceId, SHOP);
      const state = new URL(authorizeUrl).searchParams.get('state')!;
      return { state, cookieValue };
    }

    async function startThenCallback(
      service: ShopifyOAuthService,
      queryOverrides: Record<string, string | undefined> = {},
    ): Promise<string> {
      const { state, cookieValue } = start(service);
      const { query, rawQuery } = signedQuery({ state, ...queryOverrides });
      return service.handleCallback(query, cookieValue, rawQuery);
    }

    it('redirects to a generic error when state is missing or undecryptable', async () => {
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());
      const { query, rawQuery } = signedQuery({ state: 'garbage' });

      const redirect = await service.handleCallback(query, 'irrelevant', rawQuery);

      expect(redirect).toBe('http://localhost:3000?shopify=error');
    });

    it('redirects with reason=session_mismatch when the binding cookie is missing', async () => {
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());
      const { state } = start(service);
      const { query, rawQuery } = signedQuery({ state });

      const redirect = await service.handleCallback(query, undefined, rawQuery);

      expect(redirect).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=error&reason=session_mismatch');
    });

    it('redirects with reason=session_mismatch when the binding cookie does not match the state that was issued', async () => {
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());
      const { state } = start(service);
      const { query, rawQuery } = signedQuery({ state });

      const redirect = await service.handleCallback(query, 'someone-elses-cookie-value', rawQuery);

      expect(redirect).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=error&reason=session_mismatch');
    });

    it('rejects a state minted for a different workspace even with a technically-valid cookie value from that other flow', async () => {
      // Simulates the CSRF this binding exists to stop: attacker mints a
      // valid state+cookie for their own workspace, then drops the state
      // into a link a victim clicks — the victim's browser never received
      // the attacker's cookie, so the flow must fail closed.
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());
      const attackerFlow = start(service, 'attacker-ws');
      const victimBrowserCookie = 'victim-never-had-this-cookie';
      const { query, rawQuery } = signedQuery({ state: attackerFlow.state });

      const redirect = await service.handleCallback(query, victimBrowserCookie, rawQuery);

      expect(redirect).toBe('http://localhost:3000/workspace/attacker-ws/integrations?shopify=error&reason=session_mismatch');
    });

    it('redirects with reason=invalid_shop when shop fails the domain pattern', async () => {
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());

      const redirect = await startThenCallback(service, { shop: 'evil.example.com' });

      expect(redirect).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=error&reason=invalid_shop');
    });

    it('redirects with reason=invalid_signature when the hmac does not match', async () => {
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());
      const { state, cookieValue } = start(service);
      const query = { code: 'auth-code', shop: SHOP, state, hmac: 'deadbeef' };

      const redirect = await service.handleCallback(query, cookieValue, toRawQueryString(query));

      expect(redirect).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=error&reason=invalid_signature');
    });

    it('redirects with reason=invalid_signature when the raw query has malformed percent-encoding, instead of throwing', async () => {
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());
      const { state, cookieValue } = start(service);
      const { query } = signedQuery({ state });
      // A lone '%' is not valid percent-encoding — decodeURIComponent throws on this.
      const malformedRawQuery = `code=auth-code&shop=${SHOP}&state=${encodeURIComponent(state)}&hmac=${query.hmac}&bad=100%`;

      const redirect = await service.handleCallback(query, cookieValue, malformedRawQuery);

      expect(redirect).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=error&reason=invalid_signature');
    });

    it('succeeds when a callback value (e.g. host) contains a literal unencoded "+" — Fastify\'s form-decoding must not corrupt it before HMAC verification', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'shpat_new' }), { status: 200 })));
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());
      const { state, cookieValue } = start(service);
      // host is base64 and can legitimately contain '+' — build the raw query with a literal, unencoded '+'.
      const host = 'YWRtaW4rc3RvcmU='; // arbitrary base64-shaped value containing '+'
      const base = { code: 'auth-code', shop: SHOP, timestamp: '1700000000', state, host };
      const message = Object.entries(base)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
      const hmac = createHmac('sha256', CLIENT_SECRET).update(message).digest('hex');
      const query = { ...base, hmac };
      // Raw query string as Shopify would actually send it — '+' left as a literal '+', not %2B.
      const rawQuery = `code=auth-code&shop=${SHOP}&timestamp=1700000000&state=${encodeURIComponent(state)}&host=${host}&hmac=${hmac}`;

      const redirect = await service.handleCallback(query, cookieValue, rawQuery);

      expect(redirect).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=connected');
    });

    it('redirects with reason=missing_code when Shopify omits the authorization code', async () => {
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());

      const redirect = await startThenCallback(service, { code: undefined });

      expect(redirect).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=error&reason=missing_code');
    });

    it('redirects with reason=token_exchange_failed when Shopify rejects the code', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());

      const redirect = await startThenCallback(service);

      expect(redirect).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=error&reason=token_exchange_failed');
    });

    it('redirects with reason=verification_failed when the exchanged token does not verify', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'shpat_new' }), { status: 200 })));
      const adapter = makeAdapter({ verifyConnection: vi.fn(async () => false) });
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), adapter, makeLogger());

      const redirect = await startThenCallback(service);

      expect(redirect).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=error&reason=verification_failed');
    });

    it('stores the credentials through IntegrationService and redirects to connected on success', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'shpat_new' }), { status: 200 })));
      const integrationService = makeIntegrationService();
      const service = new ShopifyOAuthService(makeConfig(), integrationService, makeAdapter(), makeLogger());

      const redirect = await startThenCallback(service);

      expect(integrationService.connect).toHaveBeenCalledWith('ws_1', 'shopify');
      expect(integrationService.setCredentials).toHaveBeenCalledWith('ws_1', 'shopify', {
        shopDomain: SHOP,
        accessToken: 'shpat_new',
      });
      expect(redirect).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=connected');
    });

    it('still stores fresh credentials when the workspace is already connected (re-authorization)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'shpat_rotated' }), { status: 200 })));
      const integrationService = makeIntegrationService({
        connect: vi.fn(async () => {
          throw new ConflictError('This provider is already connected.');
        }),
      });
      const service = new ShopifyOAuthService(makeConfig(), integrationService, makeAdapter(), makeLogger());

      const redirect = await startThenCallback(service);

      expect(integrationService.setCredentials).toHaveBeenCalledWith('ws_1', 'shopify', {
        shopDomain: SHOP,
        accessToken: 'shpat_rotated',
      });
      expect(redirect).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=connected');
    });

    it('redirects with reason=expired when state is older than the allowed window', async () => {
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());
      vi.spyOn(Date, 'now').mockReturnValueOnce(1_000_000_000_000);
      const { state, cookieValue } = start(service);
      vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000 + 11 * 60 * 1000);
      const { query, rawQuery } = signedQuery({ state });

      const redirect = await service.handleCallback(query, cookieValue, rawQuery);

      expect(redirect).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=error&reason=expired');
    });
  });

  describe('connectViaClientCredentials()', () => {
    it('rejects a malformed shop domain', async () => {
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());

      await expect(service.connectViaClientCredentials('ws_1', 'not-a-shop-domain')).rejects.toThrow(ValidationError);
    });

    it('throws when Shopify OAuth is not configured', async () => {
      const service = new ShopifyOAuthService(
        makeConfig({ SHOPIFY_APP_CLIENT_ID: undefined }),
        makeIntegrationService(),
        makeAdapter(),
        makeLogger(),
      );

      await expect(service.connectViaClientCredentials('ws_1', SHOP)).rejects.toThrow('Shopify OAuth is not configured.');
    });

    it('mints a token, verifies it, and stores grantType/expiresAt through IntegrationService', async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: 'shpca_new', expires_in: 86399 }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const integrationService = makeIntegrationService();
      const adapter = makeAdapter();
      const service = new ShopifyOAuthService(makeConfig(), integrationService, adapter, makeLogger());
      const before = Date.now();

      await service.connectViaClientCredentials('ws_1', SHOP);

      expect(fetchMock).toHaveBeenCalledWith(
        `https://${SHOP}/admin/oauth/access_token`,
        expect.objectContaining({ method: 'POST', body: `grant_type=client_credentials&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}` }),
      );
      expect(adapter.verifyConnection).toHaveBeenCalledWith(
        expect.objectContaining({ shopDomain: SHOP, accessToken: 'shpca_new', grantType: 'client_credentials' }),
      );
      expect(integrationService.connect).toHaveBeenCalledWith('ws_1', 'shopify');
      const stored = (integrationService.setCredentials as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(stored[0]).toBe('ws_1');
      expect(stored[1]).toBe('shopify');
      expect(stored[2]).toMatchObject({ shopDomain: SHOP, accessToken: 'shpca_new', grantType: 'client_credentials' });
      expect(new Date(stored[2].expiresAt).getTime()).toBeGreaterThanOrEqual(before + 86399 * 1000);
    });

    it('still stores fresh credentials when the workspace is already connected (re-running for the same store)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'shpca_rotated', expires_in: 86399 }), { status: 200 })));
      const integrationService = makeIntegrationService({
        connect: vi.fn(async () => {
          throw new ConflictError('This provider is already connected.');
        }),
      });
      const service = new ShopifyOAuthService(makeConfig(), integrationService, makeAdapter(), makeLogger());

      await service.connectViaClientCredentials('ws_1', SHOP);

      expect(integrationService.setCredentials).toHaveBeenCalledWith(
        'ws_1',
        'shopify',
        expect.objectContaining({ accessToken: 'shpca_rotated' }),
      );
    });

    it('throws when Shopify rejects the client-credentials request', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), makeAdapter(), makeLogger());

      await expect(service.connectViaClientCredentials('ws_1', SHOP)).rejects.toThrow('Shopify rejected the client credentials request.');
    });

    it('throws when the minted token fails post-exchange verification', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'shpca_new', expires_in: 86399 }), { status: 200 })));
      const adapter = makeAdapter({ verifyConnection: vi.fn(async () => false) });
      const service = new ShopifyOAuthService(makeConfig(), makeIntegrationService(), adapter, makeLogger());

      await expect(service.connectViaClientCredentials('ws_1', SHOP)).rejects.toThrow('Could not verify the client-credentials token with Shopify.');
    });
  });
});
