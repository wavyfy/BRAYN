import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityResolutionController } from './identity-resolution.controller';
import { IdentityResolutionService } from './identity-resolution.service';
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

/** Owner/admin-only surface (doc09 — `matchedValue` is a raw phone number, customer PII). */
describe('IdentityResolutionController (e2e)', () => {
  let app: NestFastifyApplication;

  const identityResolutionService = {
    listDuplicates: vi.fn(async () => [{ id: 'dup_1', matchedSignal: 'phone', matchedValue: '555-1234', status: 'pending' }]),
    dismiss: vi.fn(async (_workspaceId: string, duplicateId: string) => ({ id: duplicateId, status: 'dismissed' })),
    merge: vi.fn(async (_workspaceId: string, _duplicateId: string, _reason?: string) => ({ survivingCanonicalCustomerId: 'canon_1', mergedCanonicalCustomerId: 'canon_2', mergeHistoryId: 'h_1' })),
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
      controllers: [IdentityResolutionController],
      providers: [
        { provide: IdentityResolutionService, useValue: identityResolutionService },
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
    identityResolutionService.listDuplicates.mockClear();
    identityResolutionService.dismiss.mockClear();
    identityResolutionService.merge.mockClear();
    accessLogInsert.mockClear();
    accessLogValues.mockClear();
  });

  function memberWithRole(role: string) {
    membershipService.findMembership.mockResolvedValueOnce({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role });
  }

  it('rejects an unauthenticated request and creates no access record', async () => {
    const res = await app.inject({ method: 'GET', url: '/workspaces/ws_1/identity/duplicates' });

    expect(res.statusCode).toBe(401);
    expect(identityResolutionService.listDuplicates).not.toHaveBeenCalled();
    expect(accessLogInsert).not.toHaveBeenCalled();
  });

  it('rejects a caller who is not a member of the workspace', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_2/identity/duplicates',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(403);
    expect(identityResolutionService.listDuplicates).not.toHaveBeenCalled();
    expect(accessLogInsert).not.toHaveBeenCalled();
  });

  for (const role of ['marketing', 'support', 'analyst']) {
    it(`rejects a ${role} member with 403 before the service executes, and creates no access record`, async () => {
      memberWithRole(role);

      const res = await app.inject({
        method: 'GET',
        url: '/workspaces/ws_1/identity/duplicates',
        headers: { authorization: 'Bearer valid-token' },
      });

      expect(res.statusCode).toBe(403);
      expect(identityResolutionService.listDuplicates).not.toHaveBeenCalled();
      expect(accessLogInsert).not.toHaveBeenCalled();
    });
  }

  it('allows an owner and records the access with resourceId: null', async () => {
    memberWithRole('owner');

    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1/identity/duplicates',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(identityResolutionService.listDuplicates).toHaveBeenCalledWith('ws_1');
    expect(accessLogValues).toHaveBeenCalledWith({
      workspaceId: 'ws_1',
      actorUserId: 'user_1',
      actorRole: 'owner',
      action: 'view',
      resourceType: 'identity_duplicate',
      resourceId: null,
    });
  });

  it('allows an admin and never logs the raw phone number (matchedValue) into the access record', async () => {
    memberWithRole('admin');

    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1/identity/duplicates',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(identityResolutionService.listDuplicates).toHaveBeenCalled();
    const recorded = accessLogValues.mock.calls[0][0];
    expect(JSON.stringify(recorded)).not.toContain('555-1234');
  });

  for (const action of ['dismiss', 'merge'] as const) {
    for (const role of ['marketing', 'support', 'analyst']) {
      it(`rejects ${action} by a ${role} member with 403 before the service executes`, async () => {
        memberWithRole(role);

        const res = await app.inject({
          method: 'POST',
          url: `/workspaces/ws_1/identity/duplicates/dup_1/${action}`,
          headers: { authorization: 'Bearer valid-token' },
        });

        expect(res.statusCode).toBe(403);
        expect(identityResolutionService[action]).not.toHaveBeenCalled();
      });
    }
  }

  it('lets an admin dismiss a candidate', async () => {
    memberWithRole('admin');

    const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/identity/duplicates/dup_1/dismiss', headers: { authorization: 'Bearer valid-token' } });

    expect(res.statusCode).toBe(200);
    expect(identityResolutionService.dismiss).toHaveBeenCalledWith('ws_1', 'dup_1');
  });

  it('lets an owner merge a candidate with a reason', async () => {
    memberWithRole('owner');

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/identity/duplicates/dup_1/merge',
      headers: { authorization: 'Bearer valid-token' },
      payload: { reason: 'Same shopper, confirmed by phone' },
    });

    expect(res.statusCode).toBe(200);
    expect(identityResolutionService.merge).toHaveBeenCalledWith('ws_1', 'dup_1', 'Same shopper, confirmed by phone');
    expect(res.json()).toMatchObject({ survivingCanonicalCustomerId: 'canon_1' });
  });

  it('rejects a non-string merge reason with 400', async () => {
    memberWithRole('owner');

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/identity/duplicates/dup_1/merge',
      headers: { authorization: 'Bearer valid-token' },
      payload: { reason: { nested: true } },
    });

    expect(res.statusCode).toBe(400);
    expect(identityResolutionService.merge).not.toHaveBeenCalled();
  });
});
