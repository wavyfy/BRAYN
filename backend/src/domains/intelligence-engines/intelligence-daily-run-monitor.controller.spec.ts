import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntelligenceDailyRunMonitorController } from './intelligence-daily-run-monitor.controller';
import { IntelligenceDailyRunController } from './intelligence-daily-run.controller';
import {
  IntelligenceDailyRunService,
  evaluateDailyRunFreshness,
} from './intelligence-daily-run.service';
import { InternalCronGuard } from '../../common/auth/internal-cron.guard';
import { InternalMonitorGuard } from '../../common/auth/internal-monitor.guard';
import { AuthGuard } from '../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';

const MONITOR_SECRET = 'm'.repeat(64);
const CRON_SECRET = 'c'.repeat(64);

describe('evaluateDailyRunFreshness', () => {
  const at = (iso: string) => new Date(iso);

  it('fresh once a run that started today succeeded', () => {
    expect(
      evaluateDailyRunFreshness(at('2026-11-25T09:16:12Z'), at('2026-11-25T10:00:00Z')),
    ).toEqual({ fresh: true, reason: 'succeeded_today' });
  });

  it("before the 06:00Z deadline, yesterday's success is still fresh", () => {
    expect(
      evaluateDailyRunFreshness(at('2026-11-24T01:30:54Z'), at('2026-11-25T05:59:59Z')),
    ).toEqual({ fresh: true, reason: 'awaiting_today' });
  });

  it('after the deadline without a run that started today → stale (the Nov 25, 2026 case: 08:59Z, last start Nov 24)', () => {
    expect(
      evaluateDailyRunFreshness(at('2026-11-24T01:30:54Z'), at('2026-11-25T08:59:00Z')),
    ).toEqual({ fresh: false, reason: 'missed_today' });
    expect(
      evaluateDailyRunFreshness(at('2026-11-24T01:30:54Z'), at('2026-11-25T06:00:00Z')).fresh,
    ).toBe(false);
  });

  it('distinguishes a run that started today but failed or is still running from a missed schedule', () => {
    const lastOk = at('2026-11-24T01:30:54Z');
    const now = at('2026-11-25T08:59:00Z');
    expect(
      evaluateDailyRunFreshness(lastOk, now, {
        status: 'failed',
        startedAt: at('2026-11-25T02:20:00Z'),
      }),
    ).toEqual({ fresh: false, reason: 'failed_today' });
    expect(
      evaluateDailyRunFreshness(lastOk, now, {
        status: 'partial',
        startedAt: at('2026-11-25T02:20:00Z'),
      }),
    ).toEqual({ fresh: false, reason: 'failed_today' });
    expect(
      evaluateDailyRunFreshness(lastOk, now, {
        status: 'running',
        startedAt: at('2026-11-25T08:30:00Z'),
      }),
    ).toEqual({ fresh: false, reason: 'running_today' });
    // Yesterday's latest run (a reuse never creates a row) → the schedule was missed today.
    expect(
      evaluateDailyRunFreshness(lastOk, now, { status: 'succeeded', startedAt: lastOk }),
    ).toEqual({ fresh: false, reason: 'missed_today' });
  });

  it('UTC day boundary: 23:59:59Z belongs to the earlier day, 00:00:00Z starts the next', () => {
    expect(
      evaluateDailyRunFreshness(at('2026-11-24T23:59:59Z'), at('2026-11-25T00:00:00Z')),
    ).toEqual({ fresh: true, reason: 'awaiting_today' });
    expect(
      evaluateDailyRunFreshness(at('2026-11-25T00:00:00Z'), at('2026-11-25T00:00:01Z')),
    ).toEqual({ fresh: true, reason: 'succeeded_today' });
  });

  it('a success older than yesterday is stale even before the deadline; no success ever is stale', () => {
    expect(
      evaluateDailyRunFreshness(at('2026-11-23T10:19:16Z'), at('2026-11-25T01:00:00Z')),
    ).toEqual({ fresh: false, reason: 'missed_today' });
    expect(evaluateDailyRunFreshness(null, at('2026-11-25T01:00:00Z'))).toEqual({
      fresh: false,
      reason: 'never_succeeded',
    });
  });
});

describe('IntelligenceDailyRunMonitorController (e2e)', () => {
  let app: NestFastifyApplication;
  const logger = { event: vi.fn(), log: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const fresh = {
    healthy: true,
    fresh: true,
    reason: 'succeeded_today',
    retention: 'ok',
    checkedAt: 'x',
    lastSucceededRunStartedAt: 'y',
    latestRunStatus: 'succeeded',
    latestRunStartedAt: 'y',
  };
  const dailyRunService = {
    getFreshness: vi.fn(async () => fresh),
    start: vi.fn(),
    getLatest: vi.fn(),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [IntelligenceDailyRunMonitorController, IntelligenceDailyRunController],
      providers: [
        { provide: IntelligenceDailyRunService, useValue: dailyRunService },
        { provide: StructuredLoggerService, useValue: logger },
        { provide: APP_GUARD, useClass: AuthGuard },
        InternalMonitorGuard,
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
    process.env.BRAYN_MONITOR_SECRET = MONITOR_SECRET;
    process.env.BRAYN_INTERNAL_CRON_SECRET = CRON_SECRET;
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.BRAYN_MONITOR_SECRET;
    delete process.env.BRAYN_INTERNAL_CRON_SECRET;
  });

  const get = (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/internal/monitor/daily-run', headers });

  it('200 with timestamps/statuses only while fresh', async () => {
    const res = await get({ authorization: `Bearer ${MONITOR_SECRET}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual(fresh);
  });

  it('503 when the run of today succeeded but its retention maintenance failed (a succeeded run alone is not "healthy")', async () => {
    dailyRunService.getFreshness.mockResolvedValueOnce({
      ...fresh,
      healthy: false,
      retention: 'failed',
    });
    const res = await get({ authorization: `Bearer ${MONITOR_SECRET}` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ fresh: true, retention: 'failed' });
  });

  it('a database error is a non-2xx with no SQL or values in the body', async () => {
    dailyRunService.getFreshness.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const res = await get({ authorization: `Bearer ${MONITOR_SECRET}` });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.body).not.toContain('ECONNREFUSED');
  });

  it('503 once stale, so any uptime monitor alerts', async () => {
    dailyRunService.getFreshness.mockResolvedValueOnce({
      ...fresh,
      healthy: false,
      fresh: false,
      reason: 'missed_today',
    });
    const res = await get({ authorization: `Bearer ${MONITOR_SECRET}` });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ fresh: false, reason: 'missed_today' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('fails closed (503) without a configured monitor secret, and 401 without/with a wrong bearer', async () => {
    expect((await get()).statusCode).toBe(401);
    expect((await get({ authorization: 'Bearer nope' })).statusCode).toBe(401);
    delete process.env.BRAYN_MONITOR_SECRET;
    expect((await get({ authorization: `Bearer ${MONITOR_SECRET}` })).statusCode).toBe(503);
    expect(dailyRunService.getFreshness).not.toHaveBeenCalled();
  });

  it('least privilege: the monitor secret cannot start a run, and the cron secret cannot read freshness', async () => {
    const start = await app.inject({
      method: 'POST',
      url: '/internal/intelligence/daily-run',
      headers: { authorization: `Bearer ${MONITOR_SECRET}` },
    });
    expect(start.statusCode).toBe(401);
    expect(dailyRunService.start).not.toHaveBeenCalled();
    expect((await get({ authorization: `Bearer ${CRON_SECRET}` })).statusCode).toBe(401);
  });
});
