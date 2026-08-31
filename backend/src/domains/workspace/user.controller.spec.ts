import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { WorkspaceMembershipService } from './workspace-membership.service';
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

describe('UserController (e2e)', () => {
  let app: NestFastifyApplication;

  const userService = {
    findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })),
  };
  const membershipService = {
    listByUser: vi.fn(async () => [{ id: 'ws_1', name: 'Acme', role: 'owner' }]),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [UserController],
      providers: [
        { provide: UserService, useValue: userService },
        { provide: WorkspaceMembershipService, useValue: membershipService },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter(new StructuredLoggerService()));
    // Production wires this in main.ts (bootstrap) rather than AppModule, so
    // an e2e test that skips it silently loses RequestContext propagation —
    // mirror it here the same way we mirror AuthGuard as APP_GUARD above.
    registerHttpLogging(app.getHttpAdapter().getInstance(), new StructuredLoggerService());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    await app.close();
  });

  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'GET', url: '/users/me' });
    expect(res.statusCode).toBe(401);
  });

  it('provisions and returns the current user for a valid session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users/me',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'user_1', clerkUserId: 'clerk_1' });
    expect(userService.findOrCreateByClerkId).toHaveBeenCalledWith('clerk_1');
  });

  it('rejects an unauthenticated my-workspaces request', async () => {
    const res = await app.inject({ method: 'GET', url: '/users/me/workspaces' });
    expect(res.statusCode).toBe(401);
  });

  it('lists the workspaces the current user belongs to', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/users/me/workspaces',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 'ws_1', name: 'Acme', role: 'owner' }]);
    expect(membershipService.listByUser).toHaveBeenCalledWith('user_1');
  });
});
