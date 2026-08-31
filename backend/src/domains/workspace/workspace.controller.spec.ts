import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
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

describe('WorkspaceController (e2e)', () => {
  let app: NestFastifyApplication;

  const workspaceService = {
    create: vi.fn(async (name: string) => ({ id: 'ws_1', name })),
    findById: vi.fn(async (id: string) => (id === 'ws_1' ? { id: 'ws_1', name: 'Acme' } : null)),
  };
  const userService = {
    findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })),
  };
  const membershipService = {
    addMember: vi.fn(async (workspaceId: string, userId: string, role: string) => ({
      id: 'mem_1',
      workspaceId,
      userId,
      role,
    })),
    // 'user_1' (the only caller identity these tests mint) is a member of
    // any workspace by default — the dedicated non-member test overrides
    // this with mockResolvedValueOnce(null) for its one call.
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      userId === 'user_1' ? { id: 'mem_1', workspaceId, userId, role: 'owner' } : null,
    ),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [WorkspaceController],
      providers: [
        { provide: WorkspaceService, useValue: workspaceService },
        { provide: UserService, useValue: userService },
        { provide: WorkspaceMembershipService, useValue: membershipService },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter(new StructuredLoggerService()));
    // Production wires this in main.ts (bootstrap) rather than AppModule —
    // mirror it here so RequestContext propagates the same way it does live.
    registerHttpLogging(app.getHttpAdapter().getInstance(), new StructuredLoggerService());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    await app.close();
  });

  beforeEach(() => {
    workspaceService.findById.mockClear();
  });

  it('rejects an unauthenticated create request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces',
      payload: { name: 'Acme' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a workspace for an authenticated request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { authorization: 'Bearer valid-token' },
      payload: { name: 'Acme' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: 'ws_1', name: 'Acme' });
    expect(userService.findOrCreateByClerkId).toHaveBeenCalledWith('clerk_1');
    expect(membershipService.addMember).toHaveBeenCalledWith('ws_1', 'user_1', 'owner');
  });

  it('rejects an empty name with the canonical validation error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces',
      headers: { authorization: 'Bearer valid-token' },
      payload: { name: '' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an unauthenticated read request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns a workspace by id for a member', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: 'ws_1', name: 'Acme' });
    expect(membershipService.findMembership).toHaveBeenCalledWith('ws_1', 'user_1');
  });

  it('returns 404 for a missing workspace once membership is confirmed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/missing',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects reading a workspace the caller is not a member of', async () => {
    membershipService.findMembership.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_2',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    expect(workspaceService.findById).not.toHaveBeenCalled();
  });
});
