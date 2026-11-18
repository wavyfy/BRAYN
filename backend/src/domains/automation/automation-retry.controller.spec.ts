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
import { ConflictError } from '../../common/errors/app-error';
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
const RUN_ID = '22222222-2222-4222-8222-222222222222';

/** Manual retry (doc16 decision, Nov 2, 2026): owner/admin/marketing only (doc28 Business Action Automation "Manage"). */
describe('POST /workspaces/:workspaceId/automations/:automationId/runs/:runId/retry', () => {
  let app: NestFastifyApplication;
  let role = 'owner';

  const automationService = { retryRun: vi.fn(async () => ({ id: 'run_2', status: 'succeeded' })) };
  const userService = { findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })) };
  const membershipService = {
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'ws_1' && userId === 'user_1' ? { id: 'mem_1', workspaceId, userId, role } : null,
    ),
  };

  const retry = (url = `/workspaces/ws_1/automations/${AUTOMATION_ID}/runs/${RUN_ID}/retry`, authorization = 'Bearer valid-token') =>
    app.inject({ method: 'POST', url, headers: { authorization } });

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

  beforeEach(() => automationService.retryRun.mockClear());

  for (const r of ['owner', 'admin', 'marketing']) {
    it(`a ${r} member can retry, scoped to the route workspace`, async () => {
      role = r;
      const res = await retry();
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ id: 'run_2', status: 'succeeded' });
      expect(automationService.retryRun).toHaveBeenCalledWith('ws_1', AUTOMATION_ID, RUN_ID);
    });
  }

  for (const r of ['support', 'analyst']) {
    it(`a ${r} member is refused without retrying`, async () => {
      role = r;
      expect((await retry()).statusCode).toBe(403);
      expect(automationService.retryRun).not.toHaveBeenCalled();
    });
  }

  it('surfaces a refused retry as 409', async () => {
    role = 'owner';
    automationService.retryRun.mockRejectedValueOnce(new ConflictError('Only a failed run can be retried.'));
    const res = await retry();
    expect(res.statusCode).toBe(409);
  });

  it('refuses a non-member workspace, an unauthenticated request and non-uuid ids without retrying', async () => {
    role = 'owner';
    expect((await retry(`/workspaces/ws_other/automations/${AUTOMATION_ID}/runs/${RUN_ID}/retry`)).statusCode).toBe(403);
    expect((await retry(undefined, 'Bearer bad')).statusCode).toBe(401);
    expect((await retry(`/workspaces/ws_1/automations/not-a-uuid/runs/${RUN_ID}/retry`)).statusCode).toBe(400);
    expect((await retry(`/workspaces/ws_1/automations/${AUTOMATION_ID}/runs/not-a-uuid/retry`)).statusCode).toBe(400);
    expect(automationService.retryRun).not.toHaveBeenCalled();
  });
});
