import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomerErasureController, ERASURE_CONFIRMATION } from './customer-erasure.controller';
import { CustomerErasureService } from './customer-erasure.service';
import { UserService } from '../workspace/user.service';
import { WorkspaceMembershipService } from '../workspace/workspace-membership.service';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { AuthGuard } from '../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { ServiceUnavailableError } from '../../common/errors/app-error';
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

/** Person-level erasure is permanent: owner-only, typed confirmation, workspace from the route only. */
describe('Customer erasure endpoint — role enforcement and confirmation', () => {
  let app: NestFastifyApplication;
  let role = 'owner';
  const CUSTOMER = '6f1c2b8e-0d4a-4c1e-9b7a-2e5f8c3d1a90';
  const URL = `/workspaces/ws_1/customers/${CUSTOMER}/erasure`;

  const erasureService = {
    eraseCanonicalCustomer: vi.fn(async (_ws: string, canonicalCustomerId: string) => ({
      canonicalCustomerId,
      sourceCustomersErased: 2,
      ordersErased: 3,
      webhookPayloadsCleared: 1,
      identifiersBlocked: 6,
    })),
  };
  const userService = {
    findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })),
  };
  const membershipService = {
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'ws_1' && userId === 'user_1'
        ? { id: 'mem_1', workspaceId, userId, role }
        : null,
    ),
  };
  const erase = (
    body: unknown = { confirmation: ERASURE_CONFIRMATION },
    url = URL,
    authorization = 'Bearer valid-token',
  ) =>
    app.inject({
      method: 'POST',
      url,
      headers: { authorization, 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [CustomerErasureController],
      providers: [
        { provide: CustomerErasureService, useValue: erasureService },
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
    vi.clearAllMocks();
    role = 'owner';
  });

  it('owner with the typed confirmation: erased, scoped to the route workspace, actor recorded, counts only returned', async () => {
    const response = await erase();

    expect(response.statusCode).toBe(200);
    expect(erasureService.eraseCanonicalCustomer).toHaveBeenCalledWith('ws_1', CUSTOMER, 'clerk_1');
    expect(response.json()).toEqual({
      canonicalCustomerId: CUSTOMER,
      sourceCustomersErased: 2,
      ordersErased: 3,
      webhookPayloadsCleared: 1,
      identifiersBlocked: 6,
    });
  });

  for (const r of ['admin', 'marketing', 'support', 'analyst']) {
    it(`${r} is refused without reaching the service`, async () => {
      role = r;
      expect((await erase()).statusCode).toBe(403);
      expect(erasureService.eraseCanonicalCustomer).not.toHaveBeenCalled();
    });
  }

  it('refuses a non-member workspace and an unauthenticated request', async () => {
    expect((await erase(undefined, URL.replace('ws_1', 'ws_other'))).statusCode).toBe(403);
    expect((await erase(undefined, URL, 'Bearer bad')).statusCode).toBe(401);
    expect(erasureService.eraseCanonicalCustomer).not.toHaveBeenCalled();
  });

  it('refuses a missing, wrong-case or partial confirmation, and extra fields', async () => {
    for (const body of [
      {},
      { confirmation: 'erase customer' },
      { confirmation: 'ERASE' },
      { confirmation: ERASURE_CONFIRMATION, workspaceId: 'ws_other' },
    ]) {
      expect((await erase(body)).statusCode).toBe(400);
    }
    expect(erasureService.eraseCanonicalCustomer).not.toHaveBeenCalled();
  });

  it('maps an unconfigured deployment to 503', async () => {
    erasureService.eraseCanonicalCustomer.mockRejectedValueOnce(
      new ServiceUnavailableError('Customer erasure is not configured on this deployment.'),
    );
    expect((await erase()).statusCode).toBe(503);
  });
});
