import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { NotFoundError } from '../../common/errors/app-error';
import { ImportRunService } from './import-run.service';
import type { IntegrationProvider } from './dto/connect-integration.schema';

export type IntegrationHealth = 'disconnected' | 'connected' | 'syncing' | 'healthy' | 'degraded' | 'failed';

interface IntegrationHealthInput {
  status: 'connected' | 'disconnected' | 'syncing' | 'error';
  lastSyncedAt: Date | null;
  latestImportStatus: 'running' | 'succeeded' | 'failed' | 'partial' | null;
}

/**
 * Rolls the framework state built in earlier Phase 3 parts (connection
 * status, sync state, import runs) into the merchant-facing status
 * doc 06/20 call for (Connected/Syncing/Healthy/Degraded/Failed —
 * "Authentication Required" is deliberately not derived here: nothing in
 * the framework yet distinguishes an auth-specific failure from any other
 * sync failure, and doc 19 says not to add states before code can
 * actually set them).
 *
 * `healthy` only applies once at least one sync has completed — a freshly
 * connected integration is `connected`, not yet `healthy` (doc 06
 * lifecycle: Connected → Syncing → Healthy). `degraded` reflects a
 * completed-but-imperfect import (partial), not a hard failure.
 */
export function deriveIntegrationHealth(input: IntegrationHealthInput): IntegrationHealth {
  if (input.status === 'disconnected') return 'disconnected';
  if (input.status === 'syncing') return 'syncing';
  if (input.status === 'error') return 'failed';

  if (input.latestImportStatus === 'partial') return 'degraded';
  return input.lastSyncedAt ? 'healthy' : 'connected';
}

@Injectable()
export class IntegrationHealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly importRunService: ImportRunService,
  ) {}

  async getHealth(workspaceId: string, provider: IntegrationProvider) {
    const [integration] = await this.database.client
      .select({
        status: integrations.status,
        lastSyncedAt: integrations.lastSyncedAt,
        lastSyncError: integrations.lastSyncError,
      })
      .from(integrations)
      .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider)))
      .limit(1);

    if (!integration) {
      throw new NotFoundError('This workspace has no connection for that provider.');
    }

    const latestImportRun = await this.importRunService.getLatestImportRun(workspaceId, provider);

    return {
      provider,
      status: integration.status,
      health: deriveIntegrationHealth({
        status: integration.status,
        lastSyncedAt: integration.lastSyncedAt,
        latestImportStatus: latestImportRun?.status ?? null,
      }),
      lastSyncedAt: integration.lastSyncedAt,
      lastSyncError: integration.lastSyncError,
      latestImport: latestImportRun
        ? {
            status: latestImportRun.status,
            recordsImported: latestImportRun.recordsImported,
            recordsFailed: latestImportRun.recordsFailed,
            error: latestImportRun.error,
            startedAt: latestImportRun.startedAt,
            completedAt: latestImportRun.completedAt,
          }
        : null,
    };
  }
}
