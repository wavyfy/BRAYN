import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationController } from './automation.controller';
import { AutomationService } from './automation.service';
import { UserService } from '../workspace/user.service';
import { WorkspaceMembershipService } from '../workspace/workspace-membership.service';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { AuthGuard } from '../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { registerHttpLogging } from '../../common/logging/http-logging.hook';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === 'valid-token') {
      return { sub: 'clerk_1' };
    }
    throw new Error('invalid token');
  }),
}));

const AUTOMATION_ID = '11111111-1111-4111-8111-111111111111';
type Method = 'GET' | 'POST' | 'PATCH';

/**
 * doc28 Phase 1 Permission Matrix, "Business Action Automation": Owner Full, Admin/Marketing Manage, Analyst View,
 * Support — (not permitted). Reads: owner/admin/marketing/analyst; writes: owner/admin/marketing.
 */
describe('Automation endpoints — role enforcement (doc28)', () => {
  let app: NestFastifyApplication;
  let role = 'owner';

  const automationService = {
    list: vi.fn(async () => []),
    get: vi.fn(async () => ({ id: AUTOMATION_ID })),
    listRuns: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: AUTOMATION_ID })),
    update: vi.fn(async () => ({ id: AUTOMATION_ID })),
  };
  const userService = { findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })) };
  const membershipService = {
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'ws_1' && userId === 'user_1' ? { id: 'mem_1', workspaceId, userId, role } : null,
    ),
  };

  const call = (method: Method, url: string, payload?: object, authorization = 'Bearer valid-token') =>
    app.inject({ method, url, headers: { authorization }, ...(payload ? { payload } : {}) });

  const READS: { name: string; method: Method; url: string; service: keyof typeof automationService }[] = [
    { name: 'list', method: 'GET', url: '/workspaces/ws_1/automations', service: 'list' },
    { name: 'get', method: 'GET', url: `/workspaces/ws_1/automations/${AUTOMATION_ID}`, service: 'get' },
    { name: 'runs', method: 'GET', url: `/workspaces/ws_1/automations/${AUTOMATION_ID}/runs`, service: 'listRuns' },
  ];
  const WRITES: { name: string; method: Method; url: string; payload: object; service: keyof typeof automationService }[] = [
    { name: 'create', method: 'POST', url: '/workspaces/ws_1/automations', payload: { name: 'Notify' }, service: 'create' },
    { name: 'update', method: 'PATCH', url: `/workspaces/ws_1/automations/${AUTOMATION_ID}`, payload: { enabled: false }, service: 'update' },
  ];

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [AutomationController],
      providers: [
        { provide: AutomationService, useValue: automationService },
        { provide: UserService, useValue: userService },
        { provide: WorkspaceMembershipService, useValue: membershipService },
        StructuredLoggerService,
        WorkspaceMembershipGuard,
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

  beforeEach(() => vi.clearAllMocks());

  for (const route of READS) {
    for (const r of ['owner', 'admin', 'marketing', 'analyst']) {
      it(`${route.name}: ${r} is allowed`, async () => {
        role = r;
        expect((await call(route.method, route.url)).statusCode).toBe(200);
        expect(automationService[route.service]).toHaveBeenCalledTimes(1);
      });
    }
    it(`${route.name}: support is refused without reaching the service`, async () => {
      role = 'support';
      expect((await call(route.method, route.url)).statusCode).toBe(403);
      expect(automationService[route.service]).not.toHaveBeenCalled();
    });
  }

  for (const route of WRITES) {
    for (const r of ['owner', 'admin', 'marketing']) {
      it(`${route.name}: ${r} is allowed`, async () => {
        role = r;
        expect((await call(route.method, route.url, route.payload)).statusCode).toBeLessThan(300);
        expect(automationService[route.service]).toHaveBeenCalledTimes(1);
      });
    }
    for (const r of ['analyst', 'support']) {
      it(`${route.name}: ${r} is refused without reaching the service`, async () => {
        role = r;
        expect((await call(route.method, route.url, route.payload)).statusCode).toBe(403);
        expect(automationService[route.service]).not.toHaveBeenCalled();
      });
    }
  }

  it('every route refuses a non-member workspace and an unauthenticated request', async () => {
    role = 'owner';
    for (const route of [...READS, ...WRITES]) {
      const payload = 'payload' in route ? (route as { payload: object }).payload : undefined;
      expect((await call(route.method, route.url.replace('ws_1', 'ws_other'), payload)).statusCode).toBe(403);
      expect((await call(route.method, route.url, payload, 'Bearer bad')).statusCode).toBe(401);
    }
    for (const service of Object.values(automationService)) expect(service).not.toHaveBeenCalled();
  });
});
