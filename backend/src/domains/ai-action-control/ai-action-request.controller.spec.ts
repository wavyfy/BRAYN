import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiActionRequestController } from './ai-action-request.controller';
import { AiActionControlService } from './ai-action-control.service';
import { UserService } from '../workspace/user.service';
import { WorkspaceMembershipService } from '../workspace/workspace-membership.service';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { AuthGuard } from '../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { registerHttpLogging } from '../../common/logging/http-logging.hook';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === 'valid-token') {
      return { sub: 'clerk_1' };
    }
    throw new Error('invalid token');
  }),
}));

/**
 * Doc28 Permission Matrix — "AI action approval": Owner Yes, Admin Yes,
 * Marketing/Support policy-dependent (no policy engine exists yet, doc13
 * — deferred), Analyst none. Same class-level `@RequireWorkspaceRole('owner',
 * 'admin')` guard already covers `GET`; this proves it also reaches the two
 * new POST handlers, not just the one already-tested route.
 */
describe('AiActionRequestController approve/deny (e2e)', () => {
  let app: NestFastifyApplication;

  const aiActionControlService = {
    listRecent: vi.fn(async () => []),
    approve: vi.fn(async () => undefined),
    deny: vi.fn(async () => undefined),
  };
  const userService = {
    findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })),
  };
  const membershipService = {
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'ws_1' && userId === 'user_1' ? { id: 'mem_1', workspaceId, userId, role: 'owner' } : null,
    ),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [AiActionRequestController],
      providers: [
        { provide: AiActionControlService, useValue: aiActionControlService },
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

  beforeEach(() => {
    aiActionControlService.approve.mockClear();
    aiActionControlService.deny.mockClear();
    membershipService.findMembership.mockClear();
  });

  const requestId = 'req_1';
  const approveUrl = `/workspaces/ws_1/ai-actions/${requestId}/approve`;
  const denyUrl = `/workspaces/ws_1/ai-actions/${requestId}/deny`;

  for (const [label, url] of [
    ['approve', approveUrl],
    ['deny', denyUrl],
  ] as const) {
    it(`rejects an unauthenticated ${label} request`, async () => {
      const res = await app.inject({ method: 'POST', url });

      expect(res.statusCode).toBe(401);
      expect(aiActionControlService.approve).not.toHaveBeenCalled();
      expect(aiActionControlService.deny).not.toHaveBeenCalled();
    });

    for (const role of ['marketing', 'support', 'analyst']) {
      it(`rejects a ${role} member ${label} attempt (owner/admin only, doc28 AI action approval)`, async () => {
        membershipService.findMembership.mockResolvedValueOnce({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role });

        const res = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer valid-token' } });

        expect(res.statusCode).toBe(403);
        expect(aiActionControlService.approve).not.toHaveBeenCalled();
        expect(aiActionControlService.deny).not.toHaveBeenCalled();
      });
    }

    for (const role of ['owner', 'admin']) {
      it(`allows a ${role} member to ${label}`, async () => {
        membershipService.findMembership.mockResolvedValueOnce({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role });

        const res = await app.inject({ method: 'POST', url, headers: { authorization: 'Bearer valid-token' } });

        expect(res.statusCode).toBe(204);
      });
    }
  }

  it('forwards the workspaceId and request id to the service on approve', async () => {
    const res = await app.inject({ method: 'POST', url: approveUrl, headers: { authorization: 'Bearer valid-token' } });

    expect(res.statusCode).toBe(204);
    expect(aiActionControlService.approve).toHaveBeenCalledWith(requestId, { workspaceId: 'ws_1' });
  });

  it('forwards the workspaceId and request id to the service on deny', async () => {
    const res = await app.inject({ method: 'POST', url: denyUrl, headers: { authorization: 'Bearer valid-token' } });

    expect(res.statusCode).toBe(204);
    expect(aiActionControlService.deny).toHaveBeenCalledWith(requestId, { workspaceId: 'ws_1' });
  });

  it('propagates a non-pending rejection from the service as 409', async () => {
    aiActionControlService.approve.mockRejectedValueOnce(new ConflictError('Action request is not pending approval.'));

    const res = await app.inject({ method: 'POST', url: approveUrl, headers: { authorization: 'Bearer valid-token' } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
  });

  it('propagates a cross-workspace rejection from the service as 404', async () => {
    aiActionControlService.deny.mockRejectedValueOnce(new NotFoundError('No AI action request exists in this workspace.'));

    const res = await app.inject({ method: 'POST', url: denyUrl, headers: { authorization: 'Bearer valid-token' } });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
