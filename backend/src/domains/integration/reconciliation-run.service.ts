import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { integrationReconciliationRuns } from '../../database/schema/integration-reconciliation-runs';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import { scrubSensitive } from '../../common/logging/scrub-sensitive';
import type { IntegrationProvider } from './dto/connect-integration.schema';

export type ReconciliationTrigger = 'scheduled' | 'sync_completion' | 'detected_inconsistency' | 'manual';

/**
 * Tracks reconciliation runs (doc 06/20 — Reconciliation: detect/repair
 * differences between provider and BRAYN state). Provider-agnostic
 * bookkeeping only, same scope boundary as ImportRunService — what
 * "checking a record" and "repairing a discrepancy" mean belongs to a
 * concrete provider + the domain that owns the reconciled data (Commerce,
 * once it exists), not this framework part.
 *
 * Retry for transient failures during a run is the caller's
 * responsibility via the existing generic `withRetry` helper
 * (common/async/retry.ts) — this service does not re-implement backoff.
 */
@Injectable()
export class ReconciliationRunService {
  constructor(private readonly database: DatabaseService) {}

  private async findIntegration(workspaceId: string, provider: IntegrationProvider) {
    const [integration] = await this.database.client
      .select({ id: integrations.id, status: integrations.status })
      .from(integrations)
      .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider)))
      .limit(1);

    return integration ?? null;
  }

  private async findRun(runId: string) {
    const [run] = await this.database.client
      .select()
      .from(integrationReconciliationRuns)
      .where(eq(integrationReconciliationRuns.id, runId))
      .limit(1);

    return run ?? null;
  }

  /**
   * Starts a new reconciliation run. Blocks a second concurrent run for
   * the same integration (doc 07 — don't let duplicate concurrent work
   * race) and requires the integration to be connected.
   */
  async startReconciliationRun(workspaceId: string, provider: IntegrationProvider, triggeredBy: ReconciliationTrigger) {
    const integration = await this.findIntegration(workspaceId, provider);
    if (!integration) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }
    if (integration.status === 'disconnected') {
      throw new ConflictError('Cannot reconcile a disconnected integration.');
    }

    const [activeRun] = await this.database.client
      .select({ id: integrationReconciliationRuns.id })
      .from(integrationReconciliationRuns)
      .where(
        and(
          eq(integrationReconciliationRuns.integrationId, integration.id),
          eq(integrationReconciliationRuns.status, 'running'),
        ),
      )
      .limit(1);
    if (activeRun) {
      throw new ConflictError('A reconciliation is already running for this provider.');
    }

    const [run] = await this.database.client
      .insert(integrationReconciliationRuns)
      .values({ workspaceId, integrationId: integration.id, triggeredBy })
      .returning();

    return run;
  }

  /** Records incremental progress on a running reconciliation (doc 06 — detect/repair counts). */
  async recordProgress(
    runId: string,
    progress: { recordsChecked?: number; discrepanciesFound?: number; discrepanciesRepaired?: number },
  ) {
    const run = await this.getRunningRun(runId);

    const [updated] = await this.database.client
      .update(integrationReconciliationRuns)
      .set({
        recordsChecked: progress.recordsChecked ?? run.recordsChecked,
        discrepanciesFound: progress.discrepanciesFound ?? run.discrepanciesFound,
        discrepanciesRepaired: progress.discrepanciesRepaired ?? run.discrepanciesRepaired,
      })
      .where(eq(integrationReconciliationRuns.id, runId))
      .returning();

    return updated;
  }

  /**
   * Completes a running reconciliation. `succeeded` if every discrepancy
   * found was repaired (including none found); `partial` if any remain
   * unrepaired — doc 06 "Differences must be repairable without
   * corrupting canonical data," not that every run repairs everything.
   */
  async completeReconciliationRun(runId: string) {
    const run = await this.getRunningRun(runId);

    const [updated] = await this.database.client
      .update(integrationReconciliationRuns)
      .set({
        status: run.discrepanciesRepaired < run.discrepanciesFound ? 'partial' : 'succeeded',
        completedAt: new Date(),
      })
      .where(eq(integrationReconciliationRuns.id, runId))
      .returning();

    return updated;
  }

  /** Fails a running reconciliation outright (unrecoverable error, not an unrepaired discrepancy). */
  async failReconciliationRun(runId: string, error: string) {
    await this.getRunningRun(runId);

    const [updated] = await this.database.client
      .update(integrationReconciliationRuns)
      .set({ status: 'failed', error: scrubSensitive(error), completedAt: new Date() })
      .where(eq(integrationReconciliationRuns.id, runId))
      .returning();

    return updated;
  }

  /** Most recent reconciliation run for a provider, if any. */
  async getLatestReconciliationRun(workspaceId: string, provider: IntegrationProvider) {
    const integration = await this.findIntegration(workspaceId, provider);
    if (!integration) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }

    const [run] = await this.database.client
      .select()
      .from(integrationReconciliationRuns)
      .where(eq(integrationReconciliationRuns.integrationId, integration.id))
      .orderBy(desc(integrationReconciliationRuns.startedAt))
      .limit(1);

    return run ?? null;
  }

  private async getRunningRun(runId: string) {
    const run = await this.findRun(runId);
    if (!run) {
      throw new NotFoundError('Reconciliation run not found.');
    }
    if (run.status !== 'running') {
      throw new ConflictError('This reconciliation run is not running.');
    }
    return run;
  }
}
