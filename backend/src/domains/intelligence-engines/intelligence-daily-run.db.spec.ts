import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { and, eq, gte, inArray, or } from 'drizzle-orm';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { intelligenceDailyRuns } from '../../database/schema/intelligence-daily-runs';
import { loadConfiguration } from '../../config/configuration';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { CustomerHealthService } from './customer-health.service';
import { RevenueOpportunityService } from './revenue-opportunity.service';
import { RecommendationService } from './recommendation.service';
import { DAILY_RUN_LEASE_MS, IntelligenceDailyRunService, startOfUtcDay } from './intelligence-daily-run.service';

/**
 * Real-DB checks of the run lock (same approach as idempotency.service.db.spec.ts —
 * the dev DATABASE_URL is the only supported database). Whether two concurrent starts
 * really yield one run is the partial unique index + row lock, so it's proven against
 * the real engine. `execute()` is stubbed so no test walks the shared dev customers.
 * Every run row created here is deleted afterwards.
 */
describe('IntelligenceDailyRunService run lock (real DB)', () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let service: IntelligenceDailyRunService;
  let customerIntelligence: CustomerIntelligenceService;
  const created = new Set<string>();

  const insertRun = async (values: Partial<typeof intelligenceDailyRuns.$inferInsert>) => {
    const [row] = await db.client.insert(intelligenceDailyRuns).values(values).returning();
    created.add(row.id);
    return row;
  };
  const start = async () => {
    const result = await service.start();
    created.add(result.run.id);
    return result;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [loadConfiguration] }), DatabaseModule],
      providers: [
        IntelligenceDailyRunService,
        CustomerIntelligenceService,
        { provide: StructuredLoggerService, useValue: { event: vi.fn() } },
        { provide: CustomerHealthService, useValue: {} },
        { provide: RevenueOpportunityService, useValue: {} },
        { provide: RecommendationService, useValue: {} },
      ],
    }).compile();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    service = moduleRef.get(IntelligenceDailyRunService);
    customerIntelligence = moduleRef.get(CustomerIntelligenceService);
    vi.spyOn(service, 'execute').mockResolvedValue(undefined);

    // A real run today (e.g. a local smoke test) would make start() return it instead of starting — refuse rather than touch it.
    const [existing] = await db.client
      .select()
      .from(intelligenceDailyRuns)
      .where(or(eq(intelligenceDailyRuns.status, 'running'), and(eq(intelligenceDailyRuns.status, 'succeeded'), gte(intelligenceDailyRuns.startedAt, startOfUtcDay(new Date())))));
    if (existing) {
      throw new Error(`The dev database has a running or today-succeeded daily run (${existing.id}) — this spec needs neither.`);
    }
  });

  afterEach(async () => {
    if (created.size > 0) await db.client.delete(intelligenceDailyRuns).where(inArray(intelligenceDailyRuns.id, [...created]));
    created.clear();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('starts exactly one run when many starts race', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => start()));

    const startedRuns = results.filter((r) => r.started);
    expect(startedRuns).toHaveLength(1);
    expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
    expect(service.execute).toHaveBeenCalledTimes(1);
  });

  it('returns a fresh running run as-is', async () => {
    const running = await insertRun({ status: 'running' });

    const result = await start();

    expect(result).toMatchObject({ started: false, run: { id: running.id, status: 'running' } });
  });

  it('expires a stale running run to failed and replaces it', async () => {
    const stale = await insertRun({ status: 'running', heartbeatAt: new Date(Date.now() - DAILY_RUN_LEASE_MS - 60_000) });

    const result = await start();

    expect(result.started).toBe(true);
    expect(result.run.id).not.toBe(stale.id);
    const [expired] = await db.client.select().from(intelligenceDailyRuns).where(inArray(intelligenceDailyRuns.id, [stale.id]));
    expect(expired).toMatchObject({ status: 'failed', error: expect.stringContaining('Lease expired') });
    expect(expired.completedAt).toBeInstanceOf(Date);
  });

  it('a succeeded run today closes the day', async () => {
    const done = await insertRun({ status: 'succeeded', completedAt: new Date() });

    const result = await start();

    expect(result).toMatchObject({ started: false, run: { id: done.id, status: 'succeeded' } });
  });

  it.each(['partial', 'failed'] as const)('a %s run today allows another run the same day', async (status) => {
    await insertRun({ status, completedAt: new Date() });

    expect((await start()).started).toBe(true);
  });

  it('a succeeded run from a previous UTC day does not block today', async () => {
    const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
    await insertRun({ status: 'succeeded', startedAt: yesterday, completedAt: yesterday });

    expect((await start()).started).toBe(true);
  });

  it('the database itself rejects a second running row', async () => {
    await insertRun({ status: 'running' });

    await expect(db.client.insert(intelligenceDailyRuns).values({ status: 'running' })).rejects.toMatchObject({ code: '23505' });
  });

  it('getLatest() returns the most recently started run', async () => {
    await insertRun({ status: 'failed', startedAt: new Date(Date.now() - 60_000) });
    const newest = await insertRun({ status: 'partial', startedAt: new Date() });

    expect((await service.getLatest()).id).toBe(newest.id);
  });

  it('listActiveCustomerKeys() pages by (workspaceId, id) without gaps or repeats', async () => {
    const page1 = await customerIntelligence.listActiveCustomerKeys(null, 3);
    if (page1.length < 3) return; // dev DB too small to page — nothing to assert
    const page2 = await customerIntelligence.listActiveCustomerKeys(page1[2], 3);
    const both = await customerIntelligence.listActiveCustomerKeys(null, 6);

    expect([...page1, ...page2]).toEqual(both);
  });
});
