import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InternalNotificationController } from './internal-notification.controller';
import { InternalNotificationService } from './internal-notification.service';
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

/** Doc28 Notifications row: every workspace role may view; authentication, membership and the limit are enforced server-side. */
describe('GET /workspaces/:workspaceId/notifications', () => {
  let app: NestFastifyApplication;
  let role = 'support';

  const notificationService = { list: vi.fn(async () => ({ items: [], total: 0 })) };
  const userService = { findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })) };
  const membershipService = {
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'ws_1' && userId === 'user_1' ? { id: 'mem_1', workspaceId, userId, role } : null,
    ),
  };

  const get = (url: string, authorization = 'Bearer valid-token') => app.inject({ method: 'GET', url, headers: { authorization } });

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [InternalNotificationController],
      providers: [
        { provide: InternalNotificationService, useValue: notificationService },
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

  beforeEach(() => notificationService.list.mockClear());

  for (const r of ['owner', 'admin', 'marketing', 'support', 'analyst']) {
    it(`a ${r} member can view notifications, defaulting to the newest 10`, async () => {
      role = r;
      const res = await get('/workspaces/ws_1/notifications');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [], total: 0 });
      expect(notificationService.list).toHaveBeenCalledWith('ws_1', 10);
    });
  }

  it('passes a valid limit through', async () => {
    const res = await get('/workspaces/ws_1/notifications?limit=50');
    expect(res.statusCode).toBe(200);
    expect(notificationService.list).toHaveBeenCalledWith('ws_1', 50);
  });

  it('rejects a limit outside 1–50 without querying', async () => {
    for (const limit of ['0', '51', 'abc', '2.5']) {
      expect((await get(`/workspaces/ws_1/notifications?limit=${limit}`)).statusCode).toBe(400);
    }
    expect(notificationService.list).not.toHaveBeenCalled();
  });

  it('refuses a non-member workspace and an unauthenticated request', async () => {
    expect((await get('/workspaces/ws_other/notifications')).statusCode).toBe(403);
    expect((await get('/workspaces/ws_1/notifications', 'Bearer bad')).statusCode).toBe(401);
    expect(notificationService.list).not.toHaveBeenCalled();
  });
});
