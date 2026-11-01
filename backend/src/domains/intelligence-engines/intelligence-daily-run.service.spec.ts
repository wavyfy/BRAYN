import { describe, expect, it, vi } from 'vitest';
import { DAILY_RUN_HEARTBEAT_MS, DAILY_RUN_MAX_CONSECUTIVE_FAILURES, DAILY_RUN_PAGE_SIZE, IntelligenceDailyRunService, startOfUtcDay, type IntelligenceDailyRun } from './intelligence-daily-run.service';
import type { DatabaseService } from '../../database/database.service';
import type { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import type { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import type { CustomerHealthService } from './customer-health.service';
import type { RevenueOpportunityService } from './revenue-opportunity.service';
import type { RecommendationService } from './recommendation.service';

const RUN_STARTED = new Date('2026-11-01T08:00:00Z');
const run = { id: 'run_1', status: 'running', startedAt: RUN_STARTED, heartbeatAt: RUN_STARTED } as IntelligenceDailyRun;

function keys(count: number, prefix = 'c') {
  return Array.from({ length: count }, (_, i) => ({ workspaceId: 'ws_1', id: `${prefix}${i}` }));
}

/** execute() only issues `update(...).set(...).where(...)` against the run row. */
function setup(pages: { workspaceId: string; id: string }[][], findCurrent: (id: string) => unknown = () => null) {
  const sets: Record<string, unknown>[] = [];
  const lease = { rows: [{ id: 'run_1' }] as { id: string }[] };
  const client = {
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        sets.push(values);
        // Heartbeats chain `.returning()`; the final status write awaits `where()` directly.
        return { where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: vi.fn(async () => lease.rows) })) };
      }),
    })),
  };
  const listActiveCustomerKeys = vi.fn();
  for (const page of pages) listActiveCustomerKeys.mockResolvedValueOnce(page);
  const health = {
    findCurrent: vi.fn(async (_ws: string, id: string) => findCurrent(id)),
    recalculate: vi.fn(async () => ({})),
  };
  const opportunities = { detect: vi.fn(async () => []), evaluateConversions: vi.fn(async () => 0) };
  const recommendations = { generate: vi.fn(async () => []) };
  const logger = { event: vi.fn() };
  const service = new IntelligenceDailyRunService(
    { client } as unknown as DatabaseService,
    { listActiveCustomerKeys } as unknown as CustomerIntelligenceService,
    health as unknown as CustomerHealthService,
    opportunities as unknown as RevenueOpportunityService,
    recommendations as unknown as RecommendationService,
    logger as unknown as StructuredLoggerService,
  );
  return { service, client, lease, sets, listActiveCustomerKeys, health, opportunities, recommendations, logger, final: () => sets.at(-1)! };
}

describe('IntelligenceDailyRunService.execute()', () => {
  it('recalculates (emit only on change), evaluates opportunities and generates recommendations for every customer → succeeded', async () => {
    const t = setup([keys(2)]);

    await t.service.execute(run);

    expect(t.health.recalculate).toHaveBeenCalledWith('ws_1', 'c0', { emitOnlyOnChange: true });
    expect(t.health.recalculate).toHaveBeenCalledWith('ws_1', 'c1', { emitOnlyOnChange: true });
    expect(t.opportunities.detect).toHaveBeenCalledTimes(2);
    expect(t.opportunities.detect).toHaveBeenCalledWith('ws_1', 'c0', { includeWebsite: true });
    expect(t.opportunities.evaluateConversions).toHaveBeenCalledWith('ws_1', 'c0');
    expect(t.opportunities.evaluateConversions.mock.invocationCallOrder[0]).toBeLessThan(t.opportunities.detect.mock.invocationCallOrder[0]);
    expect(t.recommendations.generate).toHaveBeenCalledTimes(2);
    expect(t.final()).toMatchObject({ status: 'succeeded', error: null, customersProcessed: 2, healthRecalculated: 2, healthSkipped: 0, customersFailed: 0 });
    expect(t.final().completedAt).toBeInstanceOf(Date);
  });

  it('skips health for a customer already recalculated since 00:00 UTC of the run day, but still evaluates opportunities/recommendations', async () => {
    const t = setup([keys(2)], (id) => ({ lastCalculatedAt: id === 'c0' ? new Date('2026-11-01T03:00:00Z') : new Date('2026-10-31T23:59:59Z') }));

    await t.service.execute(run);

    expect(t.health.recalculate).toHaveBeenCalledTimes(1);
    expect(t.health.recalculate).toHaveBeenCalledWith('ws_1', 'c1', { emitOnlyOnChange: true });
    expect(t.opportunities.detect).toHaveBeenCalledTimes(2);
    expect(t.recommendations.generate).toHaveBeenCalledTimes(2);
    expect(t.final()).toMatchObject({ status: 'succeeded', healthRecalculated: 1, healthSkipped: 1 });
  });

  it('pages through every customer with a keyset cursor and heartbeats after each page', async () => {
    const first = keys(DAILY_RUN_PAGE_SIZE, 'a');
    const t = setup([first, keys(3, 'b')]);

    await t.service.execute(run);

    expect(t.listActiveCustomerKeys).toHaveBeenNthCalledWith(1, null, DAILY_RUN_PAGE_SIZE);
    expect(t.listActiveCustomerKeys).toHaveBeenNthCalledWith(2, first.at(-1), DAILY_RUN_PAGE_SIZE);
    expect(t.listActiveCustomerKeys).toHaveBeenCalledTimes(2);
    expect(t.sets).toHaveLength(3); // two heartbeats + final
    expect(t.sets[0]).toMatchObject({ customersProcessed: DAILY_RUN_PAGE_SIZE, heartbeatAt: expect.any(Date) });
    expect(t.final()).toMatchObject({ status: 'succeeded', customersProcessed: DAILY_RUN_PAGE_SIZE + 3 });
  });

  it('isolates a failing customer, logs it without PII and finishes as partial', async () => {
    const t = setup([keys(3)]);
    t.opportunities.detect.mockRejectedValueOnce(new Error('boom'));

    await t.service.execute(run);

    expect(t.recommendations.generate).toHaveBeenCalledTimes(2);
    expect(t.final()).toMatchObject({ status: 'partial', customersProcessed: 3, customersFailed: 1, error: null });
    expect(t.logger.event).toHaveBeenCalledWith('error', 'Daily intelligence run failed for a customer', 'IntelligenceDailyRunService', {
      runId: 'run_1',
      workspaceId: 'ws_1',
      canonicalCustomerId: 'c0',
      error: 'boom',
    });
  });

  it(`aborts as failed after ${DAILY_RUN_MAX_CONSECUTIVE_FAILURES} consecutive customer failures`, async () => {
    const t = setup([keys(DAILY_RUN_MAX_CONSECUTIVE_FAILURES + 5)]);
    t.health.recalculate.mockRejectedValue(new Error('database down'));

    await t.service.execute(run);

    expect(t.health.recalculate).toHaveBeenCalledTimes(DAILY_RUN_MAX_CONSECUTIVE_FAILURES);
    expect(t.final()).toMatchObject({ status: 'failed', customersFailed: DAILY_RUN_MAX_CONSECUTIVE_FAILURES });
    expect(t.final().error).toContain('consecutive');
  });

  it('finishes as failed (never throws) when listing customers fails', async () => {
    const t = setup([]);
    t.listActiveCustomerKeys.mockRejectedValueOnce(new Error('connection refused'));

    await expect(t.service.execute(run)).resolves.toBeUndefined();

    expect(t.final()).toMatchObject({ status: 'failed', error: 'connection refused', customersProcessed: 0 });
  });

  it('does not throw when the outcome itself cannot be recorded (lease expiry recovers the row)', async () => {
    const t = setup([[]]);
    const fail = async () => Promise.reject(new Error('db gone'));
    t.client.update.mockImplementation((() => ({ set: () => ({ where: () => ({ returning: fail, then: (ok: never, ko: (e: unknown) => void) => fail().then(ok, ko) }) }) })) as never);

    await expect(t.service.execute(run)).resolves.toBeUndefined();

    expect(t.logger.event).toHaveBeenCalledWith('error', 'Could not record the daily intelligence run outcome', 'IntelligenceDailyRunService', expect.any(Object));
  });
});

describe('IntelligenceDailyRunService.execute() — heartbeat/lease', () => {
  it('heartbeats mid-page once the heartbeat interval passes, so a slow page never outlives the lease', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t = setup([keys(3)]);
      t.health.recalculate.mockImplementation(async () => (vi.setSystemTime(Date.now() + DAILY_RUN_HEARTBEAT_MS), {}));

      await t.service.execute(run);

      expect(t.sets).toHaveLength(5); // 3 per-customer heartbeats + page-end heartbeat + final
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops as failed when its row was expired by another start (lease lost), without overwriting the new owner', async () => {
    const t = setup([keys(2)]);
    t.lease.rows = [];

    await t.service.execute(run);

    expect(t.final()).toMatchObject({ status: 'failed', error: expect.stringContaining('Lease lost') });
    expect(t.logger.event).toHaveBeenCalledWith('error', 'Daily intelligence run failed', 'IntelligenceDailyRunService', expect.any(Object));
  });
});

describe('startOfUtcDay()', () => {
  it('truncates to 00:00 UTC regardless of local time', () => {
    expect(startOfUtcDay(new Date('2026-11-01T23:30:00+05:30')).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(startOfUtcDay(new Date('2026-11-01T00:10:00+05:30')).toISOString()).toBe('2026-10-31T00:00:00.000Z');
  });
});
