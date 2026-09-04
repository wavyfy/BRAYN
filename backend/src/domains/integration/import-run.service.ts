import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { integrationImportRuns } from '../../database/schema/integration-import-runs';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import { scrubSensitive } from '../../common/logging/scrub-sensitive';
import type { IntegrationProvider } from './dto/connect-integration.schema';

/**
 * Tracks initial-import runs (doc 06/20 — Initial Import: progress
 * tracking, pagination, retry, partial-failure handling, completion
 * state). Provider-agnostic bookkeeping only — a concrete provider
 * (Phase 4) drives pagination and calls recordProgress()/complete()/
 * fail() as it works through pages.
 */
@Injectable()
export class ImportRunService {
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
      .from(integrationImportRuns)
      .where(eq(integrationImportRuns.id, runId))
      .limit(1);

    return run ?? null;
  }

  /**
   * Starts a new import run. Blocks a second concurrent run for the same
   * integration (doc 07 — don't let duplicate concurrent work race) and
   * requires the integration to be connected.
   */
  async startImportRun(workspaceId: string, provider: IntegrationProvider) {
    const integration = await this.findIntegration(workspaceId, provider);
    if (!integration) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }
    if (integration.status === 'disconnected') {
      throw new ConflictError('Cannot import for a disconnected integration.');
    }

    const [activeRun] = await this.database.client
      .select({ id: integrationImportRuns.id })
      .from(integrationImportRuns)
      .where(and(eq(integrationImportRuns.integrationId, integration.id), eq(integrationImportRuns.status, 'running')))
      .limit(1);
    if (activeRun) {
      throw new ConflictError('An import is already running for this provider.');
    }

    const [run] = await this.database.client
      .insert(integrationImportRuns)
      .values({ workspaceId, integrationId: integration.id })
      .returning();

    return run;
  }

  /** Records incremental progress on a running import (doc 06 — progress tracking, pagination). */
  async recordProgress(
    runId: string,
    progress: { recordsImported?: number; recordsFailed?: number; cursor?: string },
  ) {
    const run = await this.getRunningRun(runId);

    const [updated] = await this.database.client
      .update(integrationImportRuns)
      .set({
        recordsImported: progress.recordsImported ?? run.recordsImported,
        recordsFailed: progress.recordsFailed ?? run.recordsFailed,
        cursor: progress.cursor ?? run.cursor,
      })
      .where(eq(integrationImportRuns.id, runId))
      .returning();

    return updated;
  }

  /** Completes a running import. `succeeded` unless any records failed along the way, in which case `partial`. */
  async completeImportRun(runId: string) {
    const run = await this.getRunningRun(runId);

    const [updated] = await this.database.client
      .update(integrationImportRuns)
      .set({ status: run.recordsFailed > 0 ? 'partial' : 'succeeded', completedAt: new Date() })
      .where(eq(integrationImportRuns.id, runId))
      .returning();

    return updated;
  }

  /** Fails a running import outright (unrecoverable error, not per-record partial failure). */
  async failImportRun(runId: string, error: string) {
    await this.getRunningRun(runId);

    const [updated] = await this.database.client
      .update(integrationImportRuns)
      .set({ status: 'failed', error: scrubSensitive(error), completedAt: new Date() })
      .where(eq(integrationImportRuns.id, runId))
      .returning();

    return updated;
  }

  /** Most recent import run for a provider, if any — for import completion/progress visibility. */
  async getLatestImportRun(workspaceId: string, provider: IntegrationProvider) {
    const integration = await this.findIntegration(workspaceId, provider);
    if (!integration) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }

    const [run] = await this.database.client
      .select()
      .from(integrationImportRuns)
      .where(eq(integrationImportRuns.integrationId, integration.id))
      .orderBy(desc(integrationImportRuns.startedAt))
      .limit(1);

    return run ?? null;
  }

  private async getRunningRun(runId: string) {
    const run = await this.findRun(runId);
    if (!run) {
      throw new NotFoundError('Import run not found.');
    }
    if (run.status !== 'running') {
      throw new ConflictError('This import run is not running.');
    }
    return run;
  }
}
