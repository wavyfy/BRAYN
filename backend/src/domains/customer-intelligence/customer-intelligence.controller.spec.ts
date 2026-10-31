import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerIntelligenceController } from './customer-intelligence.controller';
import { CustomerIntelligenceService } from './customer-intelligence.service';
import { CustomerMemoryService } from './customer-memory.service';
import { CustomerPreferenceService } from './customer-preference.service';
import { CustomerSummaryService } from './customer-summary.service';
import { RATE_LIMIT_TIER_KEY } from '../../common/rate-limit/rate-limit.decorator';
import { UserService } from '../workspace/user.service';
import { WorkspaceMembershipService } from '../workspace/workspace-membership.service';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { AuthGuard } from '../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { registerHttpLogging } from '../../common/logging/http-logging.hook';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { ProtectedDataAccessInterceptor } from '../../common/access-log/protected-data-access.interceptor';
import { DatabaseService } from '../../database/database.service';

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === 'valid-token') {
      return { sub: 'clerk_1' };
    }
    throw new Error('invalid token');
  }),
}));

/**
 * Owner/admin-only surface (doc10/doc18 — customer profile/activity is
 * PII: email, phone, name, order history). Covers the full role matrix on
 * `list` (the class-level `@RequireWorkspaceRole` applies to every
 * handler via the same guard) plus one owner-success check on each of the
 * other two handlers to prove the class-level decorator actually reaches
 * them too, not just the one exercised in depth.
 */
describe('CustomerIntelligenceController (e2e)', () => {
  let app: NestFastifyApplication;

  const customerIntelligenceService = {
    listCustomers: vi.fn(async () => ({ customers: [{ canonicalCustomerId: 'canon_1', email: 'a@example.com', firstName: 'Ada', lastName: 'Lovelace' }], page: 1, limit: 20, hasMore: false })),
    getCustomer: vi.fn(async () => ({ canonicalCustomerId: 'canon_1', profile: { email: 'a@example.com', firstName: 'Ada', lastName: 'Lovelace', phone: '555-1234' }, sourceCustomers: [], commerceContext: { ordersCount: 0, totalSpent: '0', lastOrderAt: null, ordersLast90Days: 0, recentOrders: [] } })),
    getActivity: vi.fn(async () => []),
  };
  const memoryEntry = { id: 'mem_entry_1', canonicalCustomerId: 'canon_1', content: 'Prefers weekend delivery', provenance: 'merchant_provided', status: 'active' };
  const customerMemoryService = {
    list: vi.fn(async () => [memoryEntry]),
    create: vi.fn(async () => memoryEntry),
    update: vi.fn(async () => memoryEntry),
    archive: vi.fn(async () => ({ ...memoryEntry, status: 'archived' })),
  };
  const preference = { id: 'pref_1', canonicalCustomerId: 'canon_1', category: 'communication', content: 'SMS only', provenance: 'merchant_provided', status: 'active' };
  const customerPreferenceService = {
    list: vi.fn(async () => [preference]),
    create: vi.fn(async () => preference),
    update: vi.fn(async () => preference),
    archive: vi.fn(async () => ({ ...preference, status: 'archived' })),
  };
  const summaryView = { summary: { content: 'A loyal repeat buyer.', provenance: 'ai_generated', model: 'm', generatedAt: new Date(0), generatedByUserId: 'user_1' }, stale: false };
  const customerSummaryService = {
    get: vi.fn(async () => summaryView),
    generate: vi.fn(async () => summaryView),
  };
  const userService = {
    findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })),
  };
  const membershipService = {
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'ws_1' && userId === 'user_1' ? { id: 'mem_1', workspaceId, userId, role: 'owner' } : null,
    ),
  };
  const accessLogValues = vi.fn(async (row: Record<string, unknown>) => void row);
  const accessLogInsert = vi.fn(() => ({ values: accessLogValues }));
  const database = { client: { insert: accessLogInsert } };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [CustomerIntelligenceController],
      providers: [
        { provide: CustomerIntelligenceService, useValue: customerIntelligenceService },
        { provide: CustomerMemoryService, useValue: customerMemoryService },
        { provide: CustomerPreferenceService, useValue: customerPreferenceService },
        { provide: CustomerSummaryService, useValue: customerSummaryService },
        { provide: UserService, useValue: userService },
        { provide: WorkspaceMembershipService, useValue: membershipService },
        { provide: DatabaseService, useValue: database },
        StructuredLoggerService,
        WorkspaceMembershipGuard,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_INTERCEPTOR, useClass: ProtectedDataAccessInterceptor },
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
    customerIntelligenceService.listCustomers.mockClear();
    customerIntelligenceService.getCustomer.mockClear();
    customerIntelligenceService.getActivity.mockClear();
    Object.values(customerMemoryService).forEach((fn) => fn.mockClear());
    Object.values(customerPreferenceService).forEach((fn) => fn.mockClear());
    Object.values(customerSummaryService).forEach((fn) => fn.mockClear());
    accessLogInsert.mockClear();
    accessLogValues.mockClear();
  });

  function memberWithRole(role: string) {
    membershipService.findMembership.mockResolvedValueOnce({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role });
  }

  describe('GET /workspaces/:workspaceId/customers', () => {
    it('rejects an unauthenticated request and creates no access record', async () => {
      const res = await app.inject({ method: 'GET', url: '/workspaces/ws_1/customers' });

      expect(res.statusCode).toBe(401);
      expect(customerIntelligenceService.listCustomers).not.toHaveBeenCalled();
      expect(accessLogInsert).not.toHaveBeenCalled();
    });

    it('rejects a caller who is not a member of the workspace', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_2/customers',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(403);
      expect(customerIntelligenceService.listCustomers).not.toHaveBeenCalled();
      expect(accessLogInsert).not.toHaveBeenCalled();
    });

    for (const role of ['marketing', 'support', 'analyst']) {
      it(`rejects a ${role} member with 403 before the service executes, and creates no access record`, async () => {
        memberWithRole(role);

        const res = await app.inject({
          method: 'GET',
          url: '/workspaces/ws_1/customers',
          headers: { authorization: 'Bearer valid-token' },
        });

        expect(res.statusCode).toBe(403);
        expect(customerIntelligenceService.listCustomers).not.toHaveBeenCalled();
        expect(accessLogInsert).not.toHaveBeenCalled();
      });
    }

    it('allows an owner and records a customer access with resourceId: null (list-level)', async () => {
      memberWithRole('owner');

      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/customers',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(customerIntelligenceService.listCustomers).toHaveBeenCalledWith('ws_1', { search: undefined, page: undefined, limit: undefined });
      expect(accessLogValues).toHaveBeenCalledWith({
        workspaceId: 'ws_1',
        actorUserId: 'user_1',
        actorRole: 'owner',
        action: 'view',
        resourceType: 'customer',
        resourceId: null,
      });
    });

    it('allows an admin and records the access with actorRole: admin', async () => {
      memberWithRole('admin');

      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/customers',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(customerIntelligenceService.listCustomers).toHaveBeenCalled();
      expect(accessLogValues).toHaveBeenCalledWith(expect.objectContaining({ actorRole: 'admin' }));
    });

    it('never logs the search query string into the access record', async () => {
      memberWithRole('owner');

      await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/customers?search=jane%40example.com',
        headers: { authorization: 'Bearer valid-token' },
      });

      const recorded = accessLogValues.mock.calls[0][0];
      expect(JSON.stringify(recorded)).not.toContain('jane@example.com');
    });
  });

  describe('GET /workspaces/:workspaceId/customers/:canonicalCustomerId', () => {
    it('rejects a support member', async () => {
      memberWithRole('support');

      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/customers/canon_1',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(403);
      expect(customerIntelligenceService.getCustomer).not.toHaveBeenCalled();
    });

    it('allows an owner and records the access with the correct canonicalCustomerId', async () => {
      memberWithRole('owner');

      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/customers/canon_1',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(customerIntelligenceService.getCustomer).toHaveBeenCalledWith('ws_1', 'canon_1');
      expect(accessLogValues).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'customer', resourceId: 'canon_1' }));
    });
  });

  describe('GET /workspaces/:workspaceId/customers/:canonicalCustomerId/activity', () => {
    it('rejects an analyst member and creates no access record', async () => {
      memberWithRole('analyst');

      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/customers/canon_1/activity',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(403);
      expect(customerIntelligenceService.getActivity).not.toHaveBeenCalled();
      expect(accessLogInsert).not.toHaveBeenCalled();
    });

    it('allows an admin and records the access with resourceType: customer_activity', async () => {
      memberWithRole('admin');

      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/customers/canon_1/activity',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(200);
      expect(customerIntelligenceService.getActivity).toHaveBeenCalledWith('ws_1', 'canon_1');
      expect(accessLogValues).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'customer_activity', resourceId: 'canon_1' }));
    });
  });

  describe('customer memory routes', () => {
    const auth = { authorization: 'Bearer valid-token' };
    const routes = [
      { method: 'GET' as const, url: '/workspaces/ws_1/customers/canon_1/memory', handler: 'list' as const },
      { method: 'POST' as const, url: '/workspaces/ws_1/customers/canon_1/memory', payload: { content: 'Note' }, handler: 'create' as const },
      { method: 'PATCH' as const, url: '/workspaces/ws_1/customers/canon_1/memory/mem_entry_1', payload: { content: 'Note' }, handler: 'update' as const },
      { method: 'POST' as const, url: '/workspaces/ws_1/customers/canon_1/memory/mem_entry_1/archive', handler: 'archive' as const },
    ];

    for (const route of routes) {
      for (const role of ['marketing', 'support', 'analyst']) {
        it(`${route.method} ${route.handler}: rejects a ${role} member with 403 before the service executes`, async () => {
          memberWithRole(role);
          const res = await app.inject({ method: route.method, url: route.url, payload: route.payload, headers: auth });
          expect(res.statusCode).toBe(403);
          expect(customerMemoryService[route.handler]).not.toHaveBeenCalled();
          expect(accessLogInsert).not.toHaveBeenCalled();
        });
      }

      it(`${route.method} ${route.handler}: rejects an unauthenticated request`, async () => {
        const res = await app.inject({ method: route.method, url: route.url, payload: route.payload });
        expect(res.statusCode).toBe(401);
        expect(customerMemoryService[route.handler]).not.toHaveBeenCalled();
      });

      for (const role of ['owner', 'admin']) {
        it(`${route.method} ${route.handler}: allows ${role} and records a customer access`, async () => {
          memberWithRole(role);
          const res = await app.inject({ method: route.method, url: route.url, payload: route.payload, headers: auth });
          expect(res.statusCode).toBe(route.method === 'POST' && route.handler === 'create' ? 201 : 200);
          expect(customerMemoryService[route.handler]).toHaveBeenCalledTimes(1);
          expect(accessLogValues).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'customer', resourceId: 'canon_1', actorRole: role }));
        });
      }
    }

    it('passes the trimmed content to the service', async () => {
      memberWithRole('owner');
      await app.inject({ method: 'POST', url: '/workspaces/ws_1/customers/canon_1/memory', payload: { content: '  Prefers SMS  ' }, headers: auth });
      expect(customerMemoryService.create).toHaveBeenCalledWith('ws_1', 'canon_1', { content: 'Prefers SMS' });
    });

    it('accepts an explicit merchant_provided provenance', async () => {
      memberWithRole('owner');
      const res = await app.inject({
        method: 'POST',
        url: '/workspaces/ws_1/customers/canon_1/memory',
        payload: { content: 'Note', provenance: 'merchant_provided' },
        headers: auth,
      });
      expect(res.statusCode).toBe(201);
    });

    for (const provenance of ['ai_generated', 'derived', 'source_backed', 'verified']) {
      it(`rejects provenance "${provenance}" with 400 and never calls the service`, async () => {
        memberWithRole('owner');
        const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/customers/canon_1/memory', payload: { content: 'Note', provenance }, headers: auth });
        expect(res.statusCode).toBe(400);
        expect(customerMemoryService.create).not.toHaveBeenCalled();
      });
    }

    it('rejects a provenance change on edit (unknown field) with 400', async () => {
      memberWithRole('owner');
      const res = await app.inject({
        method: 'PATCH',
        url: '/workspaces/ws_1/customers/canon_1/memory/mem_entry_1',
        payload: { content: 'Note', provenance: 'ai_generated' },
        headers: auth,
      });
      expect(res.statusCode).toBe(400);
      expect(customerMemoryService.update).not.toHaveBeenCalled();
    });

    for (const payload of [{}, { content: '   ' }, { content: 'x'.repeat(5001) }, { content: 42 }]) {
      it(`rejects invalid content ${JSON.stringify(payload).slice(0, 40)} with 400`, async () => {
        memberWithRole('owner');
        const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/customers/canon_1/memory', payload, headers: auth });
        expect(res.statusCode).toBe(400);
        expect(customerMemoryService.create).not.toHaveBeenCalled();
      });
    }
  });

  describe('customer preference routes', () => {
    const auth = { authorization: 'Bearer valid-token' };
    const base = '/workspaces/ws_1/customers/canon_1/preferences';
    const routes = [
      { method: 'GET' as const, url: base, handler: 'list' as const },
      { method: 'POST' as const, url: base, payload: { category: 'product', content: 'Likes linen' }, handler: 'create' as const },
      { method: 'PATCH' as const, url: `${base}/pref_1`, payload: { content: 'Likes linen' }, handler: 'update' as const },
      { method: 'POST' as const, url: `${base}/pref_1/archive`, handler: 'archive' as const },
    ];

    for (const route of routes) {
      for (const role of ['marketing', 'support', 'analyst']) {
        it(`${route.method} ${route.handler}: rejects a ${role} member with 403 before the service executes`, async () => {
          memberWithRole(role);
          const res = await app.inject({ method: route.method, url: route.url, payload: route.payload, headers: auth });
          expect(res.statusCode).toBe(403);
          expect(customerPreferenceService[route.handler]).not.toHaveBeenCalled();
          expect(accessLogInsert).not.toHaveBeenCalled();
        });
      }

      it(`${route.method} ${route.handler}: rejects an unauthenticated request`, async () => {
        const res = await app.inject({ method: route.method, url: route.url, payload: route.payload });
        expect(res.statusCode).toBe(401);
        expect(customerPreferenceService[route.handler]).not.toHaveBeenCalled();
      });

      for (const role of ['owner', 'admin']) {
        it(`${route.method} ${route.handler}: allows ${role} and records a customer access`, async () => {
          memberWithRole(role);
          const res = await app.inject({ method: route.method, url: route.url, payload: route.payload, headers: auth });
          expect(res.statusCode).toBe(route.handler === 'create' ? 201 : 200);
          expect(customerPreferenceService[route.handler]).toHaveBeenCalledTimes(1);
          expect(accessLogValues).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'customer', resourceId: 'canon_1', actorRole: role }));
        });
      }
    }

    it('passes the category and trimmed content to the service', async () => {
      memberWithRole('owner');
      await app.inject({ method: 'POST', url: base, payload: { category: 'communication', content: '  SMS only  ' }, headers: auth });
      expect(customerPreferenceService.create).toHaveBeenCalledWith('ws_1', 'canon_1', { category: 'communication', content: 'SMS only' });
    });

    for (const category of ['communication', 'product', 'behavioural', 'interaction']) {
      it(`accepts category "${category}"`, async () => {
        memberWithRole('owner');
        const res = await app.inject({ method: 'POST', url: base, payload: { category, content: 'x', provenance: 'merchant_provided' }, headers: auth });
        expect(res.statusCode).toBe(201);
      });
    }

    const invalidCreates: Record<string, unknown>[] = [
      { content: 'x' },
      { category: 'pricing', content: 'x' },
      { category: 'Communication', content: 'x' },
      { category: 'product', content: '   ' },
      { category: 'product', content: 'x'.repeat(2001) },
      { category: 'product', content: 'x', provenance: 'ai_generated' },
      { category: 'product', content: 'x', provenance: 'source_backed' },
      { category: 'product', content: 'x', tags: ['vip'] },
    ];
    for (const payload of invalidCreates) {
      it(`rejects create ${JSON.stringify(payload).slice(0, 60)} with 400`, async () => {
        memberWithRole('owner');
        const res = await app.inject({ method: 'POST', url: base, payload, headers: auth });
        expect(res.statusCode).toBe(400);
        expect(customerPreferenceService.create).not.toHaveBeenCalled();
      });
    }

    for (const payload of [{}, { category: 'pricing' }, { provenance: 'ai_generated', content: 'x' }]) {
      it(`rejects edit ${JSON.stringify(payload)} with 400`, async () => {
        memberWithRole('owner');
        const res = await app.inject({ method: 'PATCH', url: `${base}/pref_1`, payload, headers: auth });
        expect(res.statusCode).toBe(400);
        expect(customerPreferenceService.update).not.toHaveBeenCalled();
      });
    }

    it('accepts a category-only edit', async () => {
      memberWithRole('owner');
      const res = await app.inject({ method: 'PATCH', url: `${base}/pref_1`, payload: { category: 'interaction' }, headers: auth });
      expect(res.statusCode).toBe(200);
      expect(customerPreferenceService.update).toHaveBeenCalledWith('ws_1', 'canon_1', 'pref_1', { category: 'interaction' });
    });
  });

  describe('customer summary routes (Slice 4.5)', () => {
    const auth = { authorization: 'Bearer valid-token' };
    const url = '/workspaces/ws_1/customers/canon_1/summary';
    const routes = [
      { method: 'GET' as const, handler: 'get' as const },
      { method: 'POST' as const, handler: 'generate' as const },
    ];

    for (const route of routes) {
      for (const role of ['marketing', 'support', 'analyst']) {
        it(`${route.method} ${route.handler}: rejects a ${role} member with 403 before the service executes`, async () => {
          memberWithRole(role);
          const res = await app.inject({ method: route.method, url, headers: auth });
          expect(res.statusCode).toBe(403);
          expect(customerSummaryService[route.handler]).not.toHaveBeenCalled();
          expect(accessLogInsert).not.toHaveBeenCalled();
        });
      }

      it(`${route.method} ${route.handler}: rejects an unauthenticated request`, async () => {
        const res = await app.inject({ method: route.method, url });
        expect(res.statusCode).toBe(401);
        expect(customerSummaryService[route.handler]).not.toHaveBeenCalled();
      });

      for (const role of ['owner', 'admin']) {
        it(`${route.method} ${route.handler}: allows ${role}, returns the summary + stale flag, and records a customer access`, async () => {
          memberWithRole(role);
          const res = await app.inject({ method: route.method, url, headers: auth });
          expect(res.statusCode).toBe(200);
          expect(res.json()).toMatchObject({ summary: { content: 'A loyal repeat buyer.', provenance: 'ai_generated' }, stale: false });
          expect(customerSummaryService[route.handler]).toHaveBeenCalledWith('ws_1', 'canon_1');
          expect(accessLogValues).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'customer', resourceId: 'canon_1', actorRole: role }));
        });
      }
    }

    it('puts generation (an AI call) on the ai rate-limit tier, and leaves the read on the default tier', () => {
      expect(Reflect.getMetadata(RATE_LIMIT_TIER_KEY, CustomerIntelligenceController.prototype.generateSummary)).toBe('ai');
      expect(Reflect.getMetadata(RATE_LIMIT_TIER_KEY, CustomerIntelligenceController.prototype.getSummary)).toBeUndefined();
    });
  });
});
