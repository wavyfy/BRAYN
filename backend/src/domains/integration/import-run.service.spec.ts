import { describe, expect, it, vi } from 'vitest';
import { ImportRunService } from './import-run.service';
import type { DatabaseService } from '../../database/database.service';

function makeChain(finalResult: unknown) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    set: vi.fn(() => chain),
    returning: vi.fn(async () => finalResult),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => finalResult),
    then: (resolve: (value: unknown) => void) => resolve(finalResult),
  };
  return chain;
}

function makeSelectQueue(results: unknown[]) {
  let i = 0;
  return vi.fn(() => makeChain(results[i++]));
}

const integration = { id: 'int_1', status: 'connected' };
const runningRun = {
  id: 'run_1',
  workspaceId: 'ws_1',
  integrationId: 'int_1',
  status: 'running',
  cursor: null,
  recordsImported: 0,
  recordsFailed: 0,
  error: null,
};

describe('ImportRunService', () => {
  describe('startImportRun()', () => {
    it('creates a running import run when the integration is connected and idle', async () => {
      const created = { ...runningRun };
      const client = {
        select: makeSelectQueue([[integration], []]),
        insert: vi.fn(() => makeChain([created])),
      };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      const result = await service.startImportRun('ws_1', 'shopify');

      expect(result).toEqual(created);
      expect(client.insert).toHaveBeenCalled();
    });

    it('throws NotFoundError when the workspace has no connection for that provider', async () => {
      const client = { select: makeSelectQueue([[]]) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await expect(service.startImportRun('ws_1', 'shopify')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws ConflictError when the integration is disconnected', async () => {
      const client = { select: makeSelectQueue([[{ id: 'int_1', status: 'disconnected' }]]) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await expect(service.startImportRun('ws_1', 'shopify')).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('throws ConflictError when a run is already in progress', async () => {
      const client = { select: makeSelectQueue([[integration], [{ id: 'run_0' }]]) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await expect(service.startImportRun('ws_1', 'shopify')).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  describe('recordProgress()', () => {
    it('updates records/cursor on a running run, defaulting unset fields to current values', async () => {
      const updateChain = makeChain([{ ...runningRun, recordsImported: 50, cursor: 'page_2' }]);
      const client = { select: makeSelectQueue([[runningRun]]), update: vi.fn(() => updateChain) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      const result = await service.recordProgress('run_1', { recordsImported: 50, cursor: 'page_2' });

      expect(result).toMatchObject({ recordsImported: 50, cursor: 'page_2' });
      expect(updateChain.set).toHaveBeenCalledWith({ recordsImported: 50, recordsFailed: 0, cursor: 'page_2' });
    });

    it('throws NotFoundError for an unknown run', async () => {
      const client = { select: makeSelectQueue([[]]) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await expect(service.recordProgress('missing', { recordsImported: 1 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('throws ConflictError when the run is not running', async () => {
      const client = { select: makeSelectQueue([[{ ...runningRun, status: 'succeeded' }]]) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await expect(service.recordProgress('run_1', { recordsImported: 1 })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });
  });

  describe('completeImportRun()', () => {
    it('marks the run succeeded when no records failed', async () => {
      const updateChain = makeChain([{ ...runningRun, status: 'succeeded' }]);
      const client = { select: makeSelectQueue([[runningRun]]), update: vi.fn(() => updateChain) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await service.completeImportRun('run_1');

      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.status).toBe('succeeded');
      expect(setArg.completedAt).toBeInstanceOf(Date);
    });

    it('marks the run partial when some records failed', async () => {
      const withFailures = { ...runningRun, recordsFailed: 3 };
      const updateChain = makeChain([{ ...withFailures, status: 'partial' }]);
      const client = { select: makeSelectQueue([[withFailures]]), update: vi.fn(() => updateChain) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await service.completeImportRun('run_1');

      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.status).toBe('partial');
    });

    it('throws ConflictError when the run is not running', async () => {
      const client = { select: makeSelectQueue([[{ ...runningRun, status: 'failed' }]]) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await expect(service.completeImportRun('run_1')).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  describe('failImportRun()', () => {
    it('marks the run failed with the error message', async () => {
      const updateChain = makeChain([{ ...runningRun, status: 'failed', error: 'Provider timed out' }]);
      const client = { select: makeSelectQueue([[runningRun]]), update: vi.fn(() => updateChain) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      const result = await service.failImportRun('run_1', 'Provider timed out');

      expect(result).toMatchObject({ status: 'failed', error: 'Provider timed out' });
      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.completedAt).toBeInstanceOf(Date);
    });

    it('throws NotFoundError for an unknown run', async () => {
      const client = { select: makeSelectQueue([[]]) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await expect(service.failImportRun('missing', 'boom')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('scrubs sensitive text out of the error message before persisting it', async () => {
      const updateChain = makeChain([{ ...runningRun, status: 'failed' }]);
      const client = { select: makeSelectQueue([[runningRun]]), update: vi.fn(() => updateChain) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await service.failImportRun('run_1', 'auth failed for jane@example.com using Bearer sometoken1234567890');

      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.error).toBe('auth failed for [redacted-email] using Bearer [redacted-token]');
    });
  });

  describe('getLatestImportRun()', () => {
    it('returns the most recent run for the provider', async () => {
      const client = { select: makeSelectQueue([[integration], [runningRun]]) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await expect(service.getLatestImportRun('ws_1', 'shopify')).resolves.toEqual(runningRun);
    });

    it('returns null when no run has ever started', async () => {
      const client = { select: makeSelectQueue([[integration], []]) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await expect(service.getLatestImportRun('ws_1', 'shopify')).resolves.toBeNull();
    });

    it('throws NotFoundError when the workspace has no connection for that provider', async () => {
      const client = { select: makeSelectQueue([[]]) };
      const service = new ImportRunService({ client } as unknown as DatabaseService);

      await expect(service.getLatestImportRun('ws_1', 'shopify')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
