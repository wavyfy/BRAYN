import { describe, expect, it, vi } from 'vitest';
import { deriveIntegrationHealth, IntegrationHealthService } from './integration-health.service';
import type { DatabaseService } from '../../database/database.service';
import type { ImportRunService } from './import-run.service';

describe('deriveIntegrationHealth', () => {
  it('is disconnected when the integration is disconnected, regardless of import history', () => {
    expect(
      deriveIntegrationHealth({ status: 'disconnected', lastSyncedAt: new Date(), latestImportStatus: 'succeeded' }),
    ).toBe('disconnected');
  });

  it('is syncing while a sync is in progress', () => {
    expect(deriveIntegrationHealth({ status: 'syncing', lastSyncedAt: null, latestImportStatus: null })).toBe(
      'syncing',
    );
  });

  it('is failed when the last sync errored', () => {
    expect(deriveIntegrationHealth({ status: 'error', lastSyncedAt: new Date(), latestImportStatus: null })).toBe(
      'failed',
    );
  });

  it('is connected (not yet healthy) when connected but never synced', () => {
    expect(deriveIntegrationHealth({ status: 'connected', lastSyncedAt: null, latestImportStatus: null })).toBe(
      'connected',
    );
  });

  it('is healthy when connected and at least one sync has completed', () => {
    expect(
      deriveIntegrationHealth({ status: 'connected', lastSyncedAt: new Date(), latestImportStatus: 'succeeded' }),
    ).toBe('healthy');
  });

  it('is degraded when connected but the latest import was only partially successful', () => {
    expect(
      deriveIntegrationHealth({ status: 'connected', lastSyncedAt: new Date(), latestImportStatus: 'partial' }),
    ).toBe('degraded');
  });
});

function makeChain(finalResult: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => finalResult),
  };
  return chain;
}

describe('IntegrationHealthService', () => {
  it('combines integration state and the latest import run into a health snapshot', async () => {
    const row = { status: 'connected', lastSyncedAt: new Date('2026-09-01T00:00:00Z'), lastSyncError: null };
    const client = { select: vi.fn(() => makeChain([row])) };
    const importRunService = {
      getLatestImportRun: vi.fn(async () => ({
        status: 'succeeded',
        recordsImported: 10,
        recordsFailed: 0,
        error: null,
        startedAt: new Date('2026-09-01T00:00:00Z'),
        completedAt: new Date('2026-09-01T00:01:00Z'),
      })),
    } as unknown as ImportRunService;
    const service = new IntegrationHealthService({ client } as unknown as DatabaseService, importRunService);

    const result = await service.getHealth('ws_1', 'shopify');

    expect(result).toMatchObject({ provider: 'shopify', status: 'connected', health: 'healthy' });
    expect(result.latestImport).toMatchObject({ status: 'succeeded', recordsImported: 10 });
  });

  it('returns latestImport: null when no import has ever run', async () => {
    const row = { status: 'connected', lastSyncedAt: null, lastSyncError: null };
    const client = { select: vi.fn(() => makeChain([row])) };
    const importRunService = { getLatestImportRun: vi.fn(async () => null) } as unknown as ImportRunService;
    const service = new IntegrationHealthService({ client } as unknown as DatabaseService, importRunService);

    const result = await service.getHealth('ws_1', 'shopify');

    expect(result).toMatchObject({ health: 'connected', latestImport: null });
  });

  it('throws NotFoundError when the workspace has no connection for that provider', async () => {
    const client = { select: vi.fn(() => makeChain([])) };
    const importRunService = { getLatestImportRun: vi.fn() } as unknown as ImportRunService;
    const service = new IntegrationHealthService({ client } as unknown as DatabaseService, importRunService);

    await expect(service.getHealth('ws_1', 'shopify')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
