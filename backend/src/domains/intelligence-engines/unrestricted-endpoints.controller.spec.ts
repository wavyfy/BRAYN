import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DashboardController } from '../dashboard/dashboard.controller';
import { DashboardService } from '../dashboard/dashboard.service';
import { CustomerHealthController } from './customer-health.controller';
import { CustomerHealthService } from './customer-health.service';
import { RevenueOpportunityController } from './revenue-opportunity.controller';
import { RevenueOpportunityService } from './revenue-opportunity.service';
import { RecommendationController } from './recommendation.controller';
import { RecommendationService } from './recommendation.service';
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

/**
 * Regression check for Part 2 (limit staff access to customer PII):
 * dashboard/opportunities/recommendations/health carry no raw customer
 * PII (aggregate counts and generated/templated text only — see the
 * read-only inspection) and were deliberately left unrestricted. `support`
 * — one of the three roles newly locked out of the actual PII endpoints —
 * must still reach these exactly as before.
 */
describe('Unrestricted customer-adjacent endpoints (e2e regression)', () => {
  let app: NestFastifyApplication;

  const dashboardService = { getSummary: vi.fn(async () => ({ customersCount: 1 })) };
  const customerHealthService = { getCurrent: vi.fn(async () => ({ score: null })) };
  const revenueOpportunityService = { list: vi.fn(async () => []) };
  const recommendationService = { list: vi.fn(async () => []) };
  const userService = {
    findOrCreateByClerkId: vi.fn(async (clerkUserId: string) => ({ id: 'user_1', clerkUserId })),
  };
  const membershipService = {
    findMembership: vi.fn(async (workspaceId: string, userId: string) =>
      workspaceId === 'ws_1' && userId === 'user_1' ? { id: 'mem_1', workspaceId, userId, role: 'support' } : null,
    ),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [DashboardController, CustomerHealthController, RevenueOpportunityController, RecommendationController],
      providers: [
        { provide: DashboardService, useValue: dashboardService },
        { provide: CustomerHealthService, useValue: customerHealthService },
        { provide: RevenueOpportunityService, useValue: revenueOpportunityService },
        { provide: RecommendationService, useValue: recommendationService },
        { provide: UserService, useValue: userService },
        { provide: WorkspaceMembershipService, useValue: membershipService },
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

  it('a support member can still read the dashboard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1/dashboard',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(dashboardService.getSummary).toHaveBeenCalledWith('ws_1');
  });

  it('a support member can still read customer health', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1/customers/canon_1/health',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(customerHealthService.getCurrent).toHaveBeenCalledWith('ws_1', 'canon_1');
  });

  it('a support member can still read revenue opportunities', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1/customers/canon_1/opportunities',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(revenueOpportunityService.list).toHaveBeenCalledWith('ws_1', 'canon_1');
  });

  it('a support member can still read recommendations', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/workspaces/ws_1/customers/canon_1/recommendations',
      headers: { authorization: 'Bearer valid-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(recommendationService.list).toHaveBeenCalledWith('ws_1', 'canon_1');
  });
});
