import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { intelligenceDailyRuns } from '../../database/schema/intelligence-daily-runs';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { NotFoundError } from '../../common/errors/app-error';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { CustomerHealthService } from './customer-health.service';
import { RevenueOpportunityService } from './revenue-opportunity.service';
import { RecommendationService } from './recommendation.service';

export type IntelligenceDailyRun = typeof intelligenceDailyRuns.$inferSelect;

export const DAILY_RUN_PAGE_SIZE = 200;
/** A `running` row whose heartbeat is older than this belongs to a dead process. */
export const DAILY_RUN_LEASE_MS = 15 * 60 * 1000;
/** Heartbeat at least this often — time-based, so a slow page can never outlive the lease. */
export const DAILY_RUN_HEARTBEAT_MS = 60 * 1000;
/** Stop hammering a backend that is down (e.g. database outage) instead of failing every customer. */
export const DAILY_RUN_MAX_CONSECUTIVE_FAILURES = 20;

const UNIQUE_VIOLATION = '23505';

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Daily intelligence run (doc10 — "Daily recalculation as a consistency
 * mechanism"; Milestone #5 D2/D3/D5 daily part). Triggered by an external
 * scheduler (Render Cron Job, `0 2,8,14,20 * * *`) through the internal
 * endpoint — no in-process cron (D2).
 *
 * For every non-merged canonical customer, in its own workspace:
 * 1. Health: `recalculate()` unless already recalculated since 00:00 UTC of
 *    the run's day (a same-day retry never writes a second history row or
 *    flattens the trend). Publishes `customer_health.recalculated` only on
 *    change (user decision, Nov 1, 2026).
 * 2. Opportunities, then 3. recommendations: always — eligibility is
 *    time-based (a reorder falls due with no new event), and both steps
 *    create nothing twice (advisory lock / unique index). Website-derived
 *    cross_sell is evaluated here only (`includeWebsite`, Release 3).
 *
 * Run rules (user decisions, Nov 1, 2026): one `running` row at a time (DB
 * partial unique index — holds across processes/instances); a fresh
 * `running` run is returned as-is; a stale one (heartbeat older than the
 * lease) is expired to `failed` and replaced; `succeeded` closes the UTC
 * day; `partial`/`failed` allow another run the same day.
 */
@Injectable()
export class IntelligenceDailyRunService {
  constructor(
    private readonly database: DatabaseService,
    private readonly customerIntelligenceService: CustomerIntelligenceService,
    private readonly customerHealthService: CustomerHealthService,
    private readonly revenueOpportunityService: RevenueOpportunityService,
    private readonly recommendationService: RecommendationService,
    private readonly logger: StructuredLoggerService,
  ) {}

  /** Starts a run unless one is active or today already succeeded; the work continues after this returns. */
  async start(): Promise<{ run: IntelligenceDailyRun; started: boolean }> {
    let result: { run: IntelligenceDailyRun; started: boolean };
    try {
      result = await this.claim();
    } catch (error) {
      // Two starts raced past the "no running row" check; the index let exactly one insert win.
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
      const [running] = await this.database.client.select().from(intelligenceDailyRuns).where(eq(intelligenceDailyRuns.status, 'running'));
      if (!running) throw error;
      result = { run: running, started: false };
    }

    if (result.started) {
      this.logger.event('log', 'Daily intelligence run started', 'IntelligenceDailyRunService', { runId: result.run.id });
      void this.execute(result.run);
    } else {
      this.logger.event('log', `Daily intelligence run not started — existing run is ${result.run.status}`, 'IntelligenceDailyRunService', {
        runId: result.run.id,
      });
    }
    return result;
  }

  async getLatest(): Promise<IntelligenceDailyRun> {
    const [latest] = await this.database.client.select().from(intelligenceDailyRuns).orderBy(desc(intelligenceDailyRuns.startedAt)).limit(1);
    if (!latest) throw new NotFoundError('No daily intelligence run has been recorded yet.');
    return latest;
  }

  private claim(): Promise<{ run: IntelligenceDailyRun; started: boolean }> {
    return this.database.transaction(async (tx) => {
      const now = new Date();
      const [running] = await tx.select().from(intelligenceDailyRuns).where(eq(intelligenceDailyRuns.status, 'running')).for('update');
      if (running) {
        if (now.getTime() - running.heartbeatAt.getTime() < DAILY_RUN_LEASE_MS) return { run: running, started: false };
        await tx
          .update(intelligenceDailyRuns)
          .set({ status: 'failed', error: 'Lease expired — the process running this run stopped heartbeating.', completedAt: now })
          .where(eq(intelligenceDailyRuns.id, running.id));
        this.logger.event('warn', 'Expired stale daily intelligence run', 'IntelligenceDailyRunService', { runId: running.id });
      }

      const [succeededToday] = await tx
        .select()
        .from(intelligenceDailyRuns)
        .where(and(eq(intelligenceDailyRuns.status, 'succeeded'), gte(intelligenceDailyRuns.startedAt, startOfUtcDay(now))))
        .orderBy(desc(intelligenceDailyRuns.startedAt))
        .limit(1);
      if (succeededToday) return { run: succeededToday, started: false };

      const [run] = await tx.insert(intelligenceDailyRuns).values({ startedAt: now, heartbeatAt: now }).returning();
      return { run, started: true };
    });
  }

  /** Never throws — every outcome ends in a terminal status on the run row. */
  async execute(run: IntelligenceDailyRun): Promise<void> {
    const startedMs = Date.now();
    const dayStart = startOfUtcDay(run.startedAt);
    const counts = { customersProcessed: 0, healthRecalculated: 0, healthSkipped: 0, customersFailed: 0 };
    let consecutiveFailures = 0;
    let fatal: string | null = null;
    let lastBeat = Date.now();

    // Records progress; if the row is no longer `running` (another start expired it), stop — that run owns the day now.
    const beat = async () => {
      const kept = await this.database.client
        .update(intelligenceDailyRuns)
        .set({ ...counts, heartbeatAt: new Date() })
        .where(and(eq(intelligenceDailyRuns.id, run.id), eq(intelligenceDailyRuns.status, 'running')))
        .returning({ id: intelligenceDailyRuns.id });
      if (kept.length === 0) throw new Error('Lease lost — this run was expired by another start.');
      lastBeat = Date.now();
    };

    try {
      let after: { workspaceId: string; id: string } | null = null;
      for (;;) {
        const page = await this.customerIntelligenceService.listActiveCustomerKeys(after, DAILY_RUN_PAGE_SIZE);
        for (const customer of page) {
          counts.customersProcessed++;
          try {
            const current = await this.customerHealthService.findCurrent(customer.workspaceId, customer.id);
            if (current && current.lastCalculatedAt >= dayStart) {
              counts.healthSkipped++;
            } else {
              await this.customerHealthService.recalculate(customer.workspaceId, customer.id, { emitOnlyOnChange: true });
              counts.healthRecalculated++;
            }
            await this.revenueOpportunityService.detect(customer.workspaceId, customer.id, { includeWebsite: true });
            await this.recommendationService.generate(customer.workspaceId, customer.id);
            consecutiveFailures = 0;
          } catch (error) {
            counts.customersFailed++;
            consecutiveFailures++;
            this.logger.event('error', 'Daily intelligence run failed for a customer', 'IntelligenceDailyRunService', {
              runId: run.id,
              workspaceId: customer.workspaceId,
              canonicalCustomerId: customer.id,
              error: error instanceof Error ? error.message : String(error),
            });
            if (consecutiveFailures >= DAILY_RUN_MAX_CONSECUTIVE_FAILURES) {
              throw new Error(`Aborted after ${consecutiveFailures} consecutive customer failures.`);
            }
          }
          if (Date.now() - lastBeat >= DAILY_RUN_HEARTBEAT_MS) await beat();
        }

        await beat();

        if (page.length < DAILY_RUN_PAGE_SIZE) break;
        after = page[page.length - 1];
      }
    } catch (error) {
      fatal = error instanceof Error ? error.message : String(error);
    }

    const status = fatal ? 'failed' : counts.customersFailed > 0 ? 'partial' : 'succeeded';
    try {
      await this.database.client
        .update(intelligenceDailyRuns)
        .set({ ...counts, status, error: fatal, completedAt: new Date(), heartbeatAt: new Date() })
        .where(and(eq(intelligenceDailyRuns.id, run.id), eq(intelligenceDailyRuns.status, 'running')));
    } catch (error) {
      // The row stays `running`; its lease expires and the next trigger replaces it.
      this.logger.event('error', 'Could not record the daily intelligence run outcome', 'IntelligenceDailyRunService', {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.logger.event(status === 'succeeded' ? 'log' : 'error', `Daily intelligence run ${status}`, 'IntelligenceDailyRunService', {
      runId: run.id,
      ...counts,
      durationMs: Date.now() - startedMs,
      ...(fatal ? { error: fatal } : {}),
    });
  }
}
