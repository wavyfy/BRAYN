import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MerchantBusinessAnalystController } from './merchant-business-analyst.controller';
import { MerchantBusinessAnalystService } from './merchant-business-analyst.service';
import { UserService } from '../workspace/user.service';
import { WorkspaceMembershipService } from '../workspace/workspace-membership.service';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { AuthGuard } from '../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { registerHttpLogging } from '../../common/logging/http-logging.hook';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { ProviderError, UnauthorizedError } from '../../common/errors/app-error';

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === 'valid-token') {
      return { sub: 'clerk_1' };
    }
    throw new Error('invalid token');
  }),
}));

/**
 * Doc28 Phase 1 Permission Matrix — every role can "Use" Merchant
 * Business Analyst, so (unlike CustomerIntelligenceController) there is
 * no role-restriction to cover: any workspace member reaches the service.
 */
describe('MerchantBusinessAnalystController (e2e)', () => {
  let app: NestFastifyApplication;

  const merchantBusinessAnalystService = {
    ask: vi.fn(async () => ({ answer: 'BRAYN answer' })),
  };
  const userService = {
    findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })),
  };
  const membershipService = {
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'ws_1' && userId === 'user_1' ? { id: 'mem_1', workspaceId, userId, role: 'analyst' } : null,
    ),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [MerchantBusinessAnalystController],
      providers: [
        { provide: MerchantBusinessAnalystService, useValue: merchantBusinessAnalystService },
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
    merchantBusinessAnalystService.ask.mockClear();
  });

  const url = '/workspaces/ws_1/merchant-business-analyst/ask';

  it('rejects an unauthenticated request', async () => {
    const res = await app.inject({ method: 'POST', url, payload: { question: 'How are sales?' } });

    expect(res.statusCode).toBe(401);
    expect(merchantBusinessAnalystService.ask).not.toHaveBeenCalled();
  });

  it('rejects a caller who is not a member of the workspace', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_2/merchant-business-analyst/ask',
      headers: { authorization: 'Bearer valid-token' },
      payload: { question: 'How are sales?' },
    });

    expect(res.statusCode).toBe(403);
    expect(merchantBusinessAnalystService.ask).not.toHaveBeenCalled();
  });

  for (const role of ['owner', 'admin', 'marketing', 'support', 'analyst']) {
    it(`allows a ${role} member and forwards the question to the service`, async () => {
      membershipService.findMembership.mockResolvedValueOnce({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role });

      const res = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: 'Bearer valid-token' },
        payload: { question: 'How are sales this month?' },
      });

      expect(res.statusCode).toBe(201);
      expect(merchantBusinessAnalystService.ask).toHaveBeenCalledWith('ws_1', 'How are sales this month?', undefined);
      expect(res.json()).toEqual({ answer: 'BRAYN answer' });
    });
  }

  it('forwards an optional customerId to the service', async () => {
    membershipService.findMembership.mockResolvedValueOnce({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' });
    const customerId = '11111111-1111-4111-8111-111111111111';

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer valid-token' },
      payload: { question: 'What should I know about this customer?', customerId },
    });

    expect(res.statusCode).toBe(201);
    expect(merchantBusinessAnalystService.ask).toHaveBeenCalledWith('ws_1', 'What should I know about this customer?', customerId);
  });

  it('rejects a malformed customerId with a validation error, without calling the service', async () => {
    membershipService.findMembership.mockResolvedValueOnce({ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' });

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer valid-token' },
      payload: { question: 'question', customerId: 'not-a-uuid' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(merchantBusinessAnalystService.ask).not.toHaveBeenCalled();
  });

  it('rejects an empty question with a validation error, without calling the service', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer valid-token' },
      payload: { question: '' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(merchantBusinessAnalystService.ask).not.toHaveBeenCalled();
  });

  it('rejects a missing question field', async () => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer valid-token' },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(merchantBusinessAnalystService.ask).not.toHaveBeenCalled();
  });

  it('propagates a Gateway/provider failure as a safe 502', async () => {
    merchantBusinessAnalystService.ask.mockRejectedValueOnce(new ProviderError('OpenAI is not configured.'));

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer valid-token' },
      payload: { question: 'How are sales?' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('PROVIDER_ERROR');
  });

  it('propagates a role-not-permitted rejection from the service as 403', async () => {
    merchantBusinessAnalystService.ask.mockRejectedValueOnce(new UnauthorizedError('Your role does not permit accessing customer data.'));

    const res = await app.inject({
      method: 'POST',
      url,
      headers: { authorization: 'Bearer valid-token' },
      payload: { question: 'question', customerId: '11111111-1111-4111-8111-111111111111' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });
});
