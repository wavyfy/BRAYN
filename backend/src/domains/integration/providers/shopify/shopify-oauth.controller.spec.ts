import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShopifyOAuthStartController, ShopifyOAuthCallbackController } from './shopify-oauth.controller';
import { ShopifyOAuthService } from './shopify-oauth.service';
import { ShopifyOAuthHandoffService } from './shopify-oauth-handoff.service';
import { ShopifyOAuthHandoffGuard } from './shopify-oauth-handoff.guard';
import { UserService } from '../../../workspace/user.service';
import { WorkspaceMembershipService } from '../../../workspace/workspace-membership.service';
import { WorkspaceMembershipGuard } from '../../../workspace/workspace-membership.guard';
import { AuthGuard } from '../../../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../../../common/errors/all-exceptions.filter';
import { registerHttpLogging } from '../../../../common/logging/http-logging.hook';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === 'valid-token') {
      return { sub: 'clerk_1' };
    }
    throw new Error('invalid token');
  }),
}));

describe('Shopify OAuth controllers (e2e)', () => {
  let app: NestFastifyApplication;

  const shopifyOAuthService = {
    buildAuthorizeUrl: vi.fn((workspaceId: string, shopDomain: string) => ({
      authorizeUrl: `https://${shopDomain}/admin/oauth/authorize?state=fake&workspace=${workspaceId}`,
      cookieValue: 'test-bound-secret',
      cookieMaxAgeSeconds: 600,
    })),
    handleCallback: vi.fn(async () => 'http://localhost:3000/workspace/ws_1/integrations?shopify=connected'),
    connectViaClientCredentials: vi.fn(async () => undefined),
  };
  const userService = {
    findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })),
  };
  const membershipService = {
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'ws_1' && userId === 'user_1' ? { id: 'mem_1', workspaceId, userId, role: 'owner' } : null,
    ),
  };
  const handoffService = {
    mint: vi.fn(async () => ({ token: 'minted-handoff-token', expiresAt: new Date('2026-01-01T00:00:00.000Z') })),
    consume: vi.fn(async (token: string) => (token === 'valid-handoff' ? { clerkUserId: 'clerk_1' } : null)),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [ShopifyOAuthStartController, ShopifyOAuthCallbackController],
      providers: [
        { provide: ShopifyOAuthService, useValue: shopifyOAuthService },
        { provide: ShopifyOAuthHandoffService, useValue: handoffService },
        { provide: UserService, useValue: userService },
        { provide: WorkspaceMembershipService, useValue: membershipService },
        WorkspaceMembershipGuard,
        ShopifyOAuthHandoffGuard,
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter(new StructuredLoggerService()));
    registerHttpLogging(app.getHttpAdapter().getInstance(), new StructuredLoggerService());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    await app.close();
  });

  beforeEach(() => {
    shopifyOAuthService.buildAuthorizeUrl.mockClear();
    shopifyOAuthService.handleCallback.mockClear();
    shopifyOAuthService.connectViaClientCredentials.mockClear();
    handoffService.mint.mockClear();
    handoffService.consume.mockClear();
  });

  describe('POST /workspaces/:workspaceId/integrations/shopify/oauth/handoff-token', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/integrations/shopify/oauth/handoff-token' });

      expect(res.statusCode).toBe(401);
      expect(handoffService.mint).not.toHaveBeenCalled();
    });

    it('rejects a caller who is not a workspace member', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/ws_2/integrations/shopify/oauth/handoff-token',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(403);
      expect(handoffService.mint).not.toHaveBeenCalled();
    });

    it('rejects a member without owner/admin role', async () => {
      membershipService.findMembership.mockResolvedValueOnce({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'analyst' });

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/ws_1/integrations/shopify/oauth/handoff-token',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(403);
      expect(handoffService.mint).not.toHaveBeenCalled();
    });

    it('mints a handoff token for an owner, bound to the caller and workspace', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/ws_1/integrations/shopify/oauth/handoff-token',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ handoffToken: 'minted-handoff-token', expiresAt: '2026-01-01T00:00:00.000Z' });
      expect(handoffService.mint).toHaveBeenCalledWith('clerk_1', 'ws_1');
    });
  });

  describe('GET /workspaces/:workspaceId/integrations/shopify/oauth/start', () => {
    it('rejects a request with no ?handoff= at all', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/integrations/shopify/oauth/start?shopDomain=test-store.myshopify.com',
      });

      expect(res.statusCode).toBe(401);
      expect(shopifyOAuthService.buildAuthorizeUrl).not.toHaveBeenCalled();
    });

    it('rejects an invalid/expired/already-consumed handoff token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/integrations/shopify/oauth/start?shopDomain=test-store.myshopify.com&handoff=stale-or-wrong',
      });

      expect(res.statusCode).toBe(401);
      expect(shopifyOAuthService.buildAuthorizeUrl).not.toHaveBeenCalled();
    });

    it('no longer accepts the raw Clerk JWT via ?token= (superseded by the handoff token)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/integrations/shopify/oauth/start?shopDomain=test-store.myshopify.com&token=valid-token',
      });

      expect(res.statusCode).toBe(401);
      expect(shopifyOAuthService.buildAuthorizeUrl).not.toHaveBeenCalled();
    });

    it('no longer accepts the Clerk JWT via the Authorization header either — start authenticates only via the handoff token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/integrations/shopify/oauth/start?shopDomain=test-store.myshopify.com',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(401);
      expect(shopifyOAuthService.buildAuthorizeUrl).not.toHaveBeenCalled();
    });

    it('rejects a valid handoff token whose bound user is not a member of this workspace', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_2/integrations/shopify/oauth/start?shopDomain=test-store.myshopify.com&handoff=valid-handoff',
      });

      expect(res.statusCode).toBe(403);
      expect(handoffService.consume).toHaveBeenCalledWith('valid-handoff', 'ws_2');
      expect(shopifyOAuthService.buildAuthorizeUrl).not.toHaveBeenCalled();
    });

    it('rejects a member without owner/admin role', async () => {
      membershipService.findMembership.mockResolvedValueOnce({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'analyst' });

      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/integrations/shopify/oauth/start?shopDomain=test-store.myshopify.com&handoff=valid-handoff',
      });

      expect(res.statusCode).toBe(403);
      expect(shopifyOAuthService.buildAuthorizeUrl).not.toHaveBeenCalled();
    });

    it('redirects to the authorize URL for an owner authenticated via a valid handoff token, and sets the session-binding cookie', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/integrations/shopify/oauth/start?shopDomain=test-store.myshopify.com&handoff=valid-handoff',
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://test-store.myshopify.com/admin/oauth/authorize?state=fake&workspace=ws_1');
      expect(handoffService.consume).toHaveBeenCalledWith('valid-handoff', 'ws_1');
      expect(shopifyOAuthService.buildAuthorizeUrl).toHaveBeenCalledWith('ws_1', 'test-store.myshopify.com');

      const cookie = res.headers['set-cookie'] as string;
      expect(cookie).toContain('brayn_shopify_oauth_state=test-bound-secret');
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/api/v1/integrations/shopify/oauth');
    });

    it('rejects a missing shopDomain', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/integrations/shopify/oauth/start?handoff=valid-handoff',
      });

      expect(res.statusCode).toBe(400);
      expect(shopifyOAuthService.buildAuthorizeUrl).not.toHaveBeenCalled();
    });
  });

  describe('POST /workspaces/:workspaceId/integrations/shopify/oauth/client-credentials', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/ws_1/integrations/shopify/oauth/client-credentials',
        payload: { shopDomain: 'test-store.myshopify.com' },
      });

      expect(res.statusCode).toBe(401);
      expect(shopifyOAuthService.connectViaClientCredentials).not.toHaveBeenCalled();
    });

    it('rejects a member without owner/admin role', async () => {
      membershipService.findMembership.mockResolvedValueOnce({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'analyst' });

      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/ws_1/integrations/shopify/oauth/client-credentials',
        headers: { authorization: 'Bearer valid-token' },
        payload: { shopDomain: 'test-store.myshopify.com' },
      });

      expect(res.statusCode).toBe(403);
      expect(shopifyOAuthService.connectViaClientCredentials).not.toHaveBeenCalled();
    });

    it('connects for an owner and returns 204', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/ws_1/integrations/shopify/oauth/client-credentials',
        headers: { authorization: 'Bearer valid-token' },
        payload: { shopDomain: 'test-store.myshopify.com' },
      });

      expect(res.statusCode).toBe(204);
      expect(shopifyOAuthService.connectViaClientCredentials).toHaveBeenCalledWith('ws_1', 'test-store.myshopify.com');
    });

    it('rejects a missing shopDomain', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/ws_1/integrations/shopify/oauth/client-credentials',
        headers: { authorization: 'Bearer valid-token' },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(shopifyOAuthService.connectViaClientCredentials).not.toHaveBeenCalled();
    });
  });

  describe('GET /integrations/shopify/oauth/callback', () => {
    it('redirects without requiring any authentication, forwarding the binding cookie to the service', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/integrations/shopify/oauth/callback?code=abc&shop=test-store.myshopify.com&state=xyz&hmac=deadbeef',
        headers: { cookie: 'brayn_shopify_oauth_state=test-bound-secret; other=ignored' },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/workspace/ws_1/integrations?shopify=connected');
      expect(shopifyOAuthService.handleCallback).toHaveBeenCalledWith(
        { code: 'abc', shop: 'test-store.myshopify.com', state: 'xyz', hmac: 'deadbeef' },
        'test-bound-secret',
        'code=abc&shop=test-store.myshopify.com&state=xyz&hmac=deadbeef',
      );
    });

    it('passes undefined to the service when no binding cookie is present', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/integrations/shopify/oauth/callback?code=abc&shop=test-store.myshopify.com&state=xyz&hmac=deadbeef',
      });

      expect(res.statusCode).toBe(302);
      expect(shopifyOAuthService.handleCallback).toHaveBeenCalledWith(expect.anything(), undefined, expect.any(String));
    });

    it('passes the raw, undecoded query string through — preserving a literal "+" rather than the framework decoding it as a space', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/integrations/shopify/oauth/callback?code=abc&shop=test-store.myshopify.com&state=xyz&hmac=deadbeef&host=admin+store',
      });

      expect(res.statusCode).toBe(302);
      const [, , rawQuery] = (shopifyOAuthService.handleCallback as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [unknown, unknown, string];
      expect(rawQuery).toBe('code=abc&shop=test-store.myshopify.com&state=xyz&hmac=deadbeef&host=admin+store');
    });

    it('clears the binding cookie on the way out', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/integrations/shopify/oauth/callback?code=abc&shop=test-store.myshopify.com&state=xyz&hmac=deadbeef',
        headers: { cookie: 'brayn_shopify_oauth_state=test-bound-secret' },
      });

      const cookie = res.headers['set-cookie'] as string;
      expect(cookie).toContain('brayn_shopify_oauth_state=;');
      expect(cookie).toContain('Max-Age=0');
    });
  });
});
