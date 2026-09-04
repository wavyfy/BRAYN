import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerIntelligenceController } from './customer-intelligence.controller';
import { CustomerIntelligenceService } from './customer-intelligence.service';
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
});
