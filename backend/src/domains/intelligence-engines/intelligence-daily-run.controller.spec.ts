import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntelligenceDailyRunController } from './intelligence-daily-run.controller';
import { IntelligenceDailyRunService } from './intelligence-daily-run.service';
import { InternalCronGuard } from '../../common/auth/internal-cron.guard';
import { AuthGuard } from '../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { NotFoundError } from '../../common/errors/app-error';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';

const SECRET = 'a'.repeat(64);
const startedAt = new Date('2026-11-01T02:00:00Z');

describe('IntelligenceDailyRunController (e2e)', () => {
  let app: NestFastifyApplication;
  const logger = { event: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const dailyRunService = {
    start: vi.fn(async () => ({ run: { id: 'run_1', status: 'running', startedAt }, started: true })),
    getLatest: vi.fn(async () => ({
      id: 'run_1',
      status: 'partial',
      customersProcessed: 10,
      healthRecalculated: 7,
      healthSkipped: 3,
      customersFailed: 1,
      error: null,
      startedAt,
      heartbeatAt: startedAt,
      completedAt: startedAt,
      createdAt: startedAt,
    })),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [IntelligenceDailyRunController],
      providers: [
        { provide: IntelligenceDailyRunService, useValue: dailyRunService },
        { provide: StructuredLoggerService, useValue: logger },
        { provide: APP_GUARD, useClass: AuthGuard },
        InternalCronGuard,
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalFilters(new AllExceptionsFilter(new StructuredLoggerService()));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    await app.close();
  });

  beforeEach(() => {
    process.env.BRAYN_INTERNAL_CRON_SECRET = SECRET;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.BRAYN_INTERNAL_CRON_SECRET;
  });

  const post = (headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/internal/intelligence/daily-run', headers });
  const bearer = { authorization: `Bearer ${SECRET}` };

  it('fails closed with 503 when no secret is configured — even with a bearer header, and never starts a run', async () => {
    delete process.env.BRAYN_INTERNAL_CRON_SECRET;

    const res = await post(bearer);

    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SERVICE_UNAVAILABLE');
    expect(dailyRunService.start).not.toHaveBeenCalled();
  });

  it('rejects a missing Authorization header with 401 and logs without any secret material', async () => {
    const res = await post();

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
    expect(dailyRunService.start).not.toHaveBeenCalled();
    expect(logger.event).toHaveBeenCalledWith('warn', 'Rejected internal cron request', 'InternalCronGuard', expect.objectContaining({ reason: 'missing_secret' }));
  });

  it.each([
    ['a wrong secret', `Bearer ${'b'.repeat(64)}`],
    ['a prefix of the secret', `Bearer ${SECRET.slice(0, 10)}`],
    ['the secret without the Bearer scheme', SECRET],
    ['a Clerk-style token', 'Bearer valid-token'],
  ])('rejects %s with 401', async (_label, authorization) => {
    const res = await post({ authorization });

    expect(res.statusCode).toBe(401);
    expect(dailyRunService.start).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.event.mock.calls)).not.toContain(authorization.replace('Bearer ', ''));
  });

  it('returns 202 with the run reference when a run starts', async () => {
    const res = await post(bearer);

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ runId: 'run_1', status: 'running', started: true, startedAt: startedAt.toISOString() });
  });

  it('returns 200 with the existing run when one is already running or today already succeeded', async () => {
    dailyRunService.start.mockResolvedValueOnce({ run: { id: 'run_0', status: 'succeeded', startedAt }, started: false });

    const res = await post(bearer);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ runId: 'run_0', status: 'succeeded', started: false });
  });

  it('GET latest returns the run state behind the same guard', async () => {
    expect((await app.inject({ method: 'GET', url: '/internal/intelligence/daily-run/latest' })).statusCode).toBe(401);

    const res = await app.inject({ method: 'GET', url: '/internal/intelligence/daily-run/latest', headers: bearer });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      runId: 'run_1',
      status: 'partial',
      customersProcessed: 10,
      healthRecalculated: 7,
      healthSkipped: 3,
      customersFailed: 1,
      error: null,
      startedAt: startedAt.toISOString(),
      heartbeatAt: startedAt.toISOString(),
      completedAt: startedAt.toISOString(),
    });
  });

  it('GET latest returns 404 before any run exists', async () => {
    dailyRunService.getLatest.mockRejectedValueOnce(new NotFoundError('No daily intelligence run has been recorded yet.'));

    const res = await app.inject({ method: 'GET', url: '/internal/intelligence/daily-run/latest', headers: bearer });

    expect(res.statusCode).toBe(404);
  });
});
