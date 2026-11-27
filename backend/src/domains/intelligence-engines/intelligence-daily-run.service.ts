import { Injectable, Optional } from '@nestjs/common';
import { ShopifyCredentialKeepAliveService } from '../integration/providers/shopify/shopify-credential-keepalive.service';
import { and, desc, eq, gte } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { intelligenceDailyRuns } from '../../database/schema/intelligence-daily-runs';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { NotFoundError } from '../../common/errors/app-error';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { CustomerHealthService } from './customer-health.service';
import { RevenueOpportunityService } from './revenue-opportunity.service';
import { RecommendationService } from './recommendation.service';
import { captureException } from '../../common/observability/sentry';
import { applyCheckoutSessionRetention, DEFAULT_CHECKOUT_UNMATCHED_RETENTION_DAYS } from '../integration/checkout-session.service';
import { applyCompliancePayloadRetention } from '../integration/providers/shopify/shopify-compliance-retention';

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

/** By this hour (UTC) a run must have succeeded today; the scheduler's first slot is 02:17, so one slot may slip. */
export const DAILY_RUN_FRESHNESS_DEADLINE_HOURS = 6;
const HOUR_MS = 60 * 60 * 1000;

export type DailyRunFreshnessReason =
  | 'succeeded_today'
  | 'awaiting_today'
  /** A run started today but ended failed/partial — the trigger worked, the execution didn't. */
  | 'failed_today'
  /** A run started today and is still running past the deadline. */
  | 'running_today'
  /** No run started today at all — the schedule itself was missed. */
  | 'missed_today'
  | 'never_succeeded';

/** Prefix of `intelligence_daily_runs.error` on a run that succeeded but whose retention maintenance failed. */
export const RETENTION_ERROR_PREFIX = 'retention: ';

/**
 * Missed-run detection (Nov 25, 2026: GitHub dropped every scheduled slot of a UTC day). Fresh = a run that started
 * today has succeeded, or it is still before the deadline and yesterday's run succeeded. A reused older run never
 * counts, because only `startedAt` of a succeeded run is considered.
 */
export function evaluateDailyRunFreshness(
  lastSucceededStartedAt: Date | null,
  now: Date,
  latest: { status: string; startedAt: Date } | null = null,
): { fresh: boolean; reason: DailyRunFreshnessReason } {
  const dayStart = startOfUtcDay(now).getTime();
  if (lastSucceededStartedAt && lastSucceededStartedAt.getTime() >= dayStart) {
    return { fresh: true, reason: 'succeeded_today' };
  }
  const beforeDeadline = now.getTime() < dayStart + DAILY_RUN_FRESHNESS_DEADLINE_HOURS * HOUR_MS;
  if (beforeDeadline && lastSucceededStartedAt && lastSucceededStartedAt.getTime() >= dayStart - 24 * HOUR_MS) {
    return { fresh: true, reason: 'awaiting_today' };
  }
  if (latest && latest.startedAt.getTime() >= dayStart) {
    return { fresh: false, reason: latest.status === 'running' ? 'running_today' : 'failed_today' };
  }
  return { fresh: false, reason: lastSucceededStartedAt ? 'missed_today' : 'never_succeeded' };
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
 * 2. Opportunities (conversions of executed ones first, #8), then 3. recommendations: always — eligibility is
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
    @Optional() private readonly shopifyCredentialKeepAlive?: ShopifyCredentialKeepAliveService,
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

  /** Freshness for the external monitor: timestamps and statuses only, no customer data. */
  /**
   * Healthy = fresh AND today's retention maintenance did not fail (a succeeded intelligence run alone must not report
   * maintenance healthy). Retention is `unknown` until a run has succeeded today.
   */
  async getFreshness(now = new Date()) {
    const runs = intelligenceDailyRuns;
    const [lastSucceeded] = await this.database.client
      .select({ startedAt: runs.startedAt, error: runs.error })
      .from(runs)
      .where(eq(runs.status, 'succeeded'))
      .orderBy(desc(runs.startedAt))
      .limit(1);
    const [latest] = await this.database.client.select({ status: runs.status, startedAt: runs.startedAt }).from(runs).orderBy(desc(runs.startedAt)).limit(1);
    const freshness = evaluateDailyRunFreshness(lastSucceeded?.startedAt ?? null, now, latest ?? null);
    const retention =
      freshness.reason !== 'succeeded_today' ? 'unknown' : lastSucceeded?.error?.startsWith(RETENTION_ERROR_PREFIX) ? 'failed' : 'ok';
    return {
      healthy: freshness.fresh && retention !== 'failed',
      ...freshness,
      retention,
      checkedAt: now.toISOString(),
      lastSucceededRunStartedAt: lastSucceeded?.startedAt.toISOString() ?? null,
      latestRunStatus: latest?.status ?? null,
      latestRunStartedAt: latest?.startedAt.toISOString() ?? null,
    };
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

    // Checkout-signal privacy maintenance rides on this existing daily job (no new scheduler). Its failure is logged,
    // sent to Sentry and recorded on the run row (`error`, RETENTION_ERROR_PREFIX) so the freshness check reports it —
    // it never fails the intelligence run itself.
    let retentionError: string | null = null;
    try {
      const retention = await applyCheckoutSessionRetention(this.database.client, new Date(), DEFAULT_CHECKOUT_UNMATCHED_RETENTION_DAYS);
      this.logger.event('log', 'Checkout session retention applied', 'IntelligenceDailyRunService', { runId: run.id, ...retention });
      // Shopify compliance: expired payloads of unresolved deliveries cleared; open ones escalated daily (counts only).
      const compliance = await applyCompliancePayloadRetention(this.database.client, new Date());
      this.logger.event(
        compliance.complianceOverdue > 0 ? 'error' : 'log',
        compliance.complianceOverdue > 0 ? 'Shopify compliance deliveries overdue for operator action' : 'Shopify compliance retention applied',
        'IntelligenceDailyRunService',
        { runId: run.id, ...compliance },
      );
    } catch (error) {
      this.logger.event('error', 'Checkout session retention failed', 'IntelligenceDailyRunService', {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
      // Operational visibility: a privacy-maintenance failure must reach error tracking, not only the log (scrubbed
      // like every Sentry event). No-op when Sentry isn't configured.
      captureException(error);
      retentionError = `${RETENTION_ERROR_PREFIX}${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
    }

    // Shopify credential keep-alive rides on the same daily job, in this runtime (it holds the credential key). Per-store
    // failures are recorded on the integration and alerted by the Shopify monitor; they never fail the intelligence run.
    try {
      await this.shopifyCredentialKeepAlive?.run(new Date());
    } catch (error) {
      this.logger.event('error', 'Shopify credential keep-alive could not run', 'IntelligenceDailyRunService', {
        runId: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
      captureException(error);
    }

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
            await this.revenueOpportunityService.evaluateConversions(customer.workspaceId, customer.id);
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
        .set({ ...counts, status, error: fatal ?? retentionError, completedAt: new Date(), heartbeatAt: new Date() })
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
