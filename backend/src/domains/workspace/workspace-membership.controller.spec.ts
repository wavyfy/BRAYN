import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceMembershipController } from './workspace-membership.controller';
import { WorkspaceMembershipService } from './workspace-membership.service';
import { UserService } from './user.service';
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

describe('WorkspaceMembershipController (e2e)', () => {
  let app: NestFastifyApplication;

  const userService = {
    findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })),
  };
  const membershipService = {
    addMember: vi.fn(async (workspaceId: string, userId: string, role: string) => ({
      id: 'mem_new',
      workspaceId,
      userId,
      role,
    })),
    listByWorkspace: vi.fn(async (workspaceId: string) => [
      { id: 'mem_1', workspaceId, userId: 'user_1', role: 'owner' },
    ]),
    // Caller ('user_1') is an owner member of 'ws_1' by default — happy-path tests build on this.
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'ws_1' && userId === 'user_1' ? { id: 'mem_1', workspaceId, userId, role: 'owner' } : null,
    ),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [WorkspaceMembershipController],
      providers: [
        { provide: WorkspaceMembershipService, useValue: membershipService },
        { provide: UserService, useValue: userService },
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
    membershipService.addMember.mockClear();
    membershipService.listByWorkspace.mockClear();
  });

  it('rejects an unauthenticated add-member request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/members',
      payload: { userId: '11111111-1111-4111-8111-111111111111', role: 'admin' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects add-member from a caller who is not a member of the workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_other/members',
      headers: { authorization: 'Bearer valid-token' },
      payload: { userId: '11111111-1111-4111-8111-111111111111', role: 'admin' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(membershipService.addMember).not.toHaveBeenCalled();
  });

  it('rejects add-member from a member without owner/admin role', async () => {
    membershipService.findMembership.mockResolvedValueOnce({
      id: 'mem_1',
      workspaceId: 'ws_1',
      userId: 'user_1',
      role: 'support',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/members',
      headers: { authorization: 'Bearer valid-token' },
      payload: { userId: '11111111-1111-4111-8111-111111111111', role: 'admin' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(membershipService.addMember).not.toHaveBeenCalled();
  });

  it('adds a member for an owner/admin caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/members',
      headers: { authorization: 'Bearer valid-token' },
      payload: { userId: '11111111-1111-4111-8111-111111111111', role: 'admin' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: 'mem_new',
      workspaceId: 'ws_1',
      userId: '11111111-1111-4111-8111-111111111111',
      role: 'admin',
    });
  });

  it('rejects an invalid role with the canonical validation error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/members',
      headers: { authorization: 'Bearer valid-token' },
      payload: { userId: '11111111-1111-4111-8111-111111111111', role: 'ceo' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a non-uuid userId with the canonical validation error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/members',
      headers: { authorization: 'Bearer valid-token' },
      payload: { userId: 'not-a-uuid', role: 'admin' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects listing members for a caller who is not a member of the workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_other/members',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(membershipService.listByWorkspace).not.toHaveBeenCalled();
  });

  it('lists members for a workspace when the caller is a member', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1/members',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' }]);
  });
});
