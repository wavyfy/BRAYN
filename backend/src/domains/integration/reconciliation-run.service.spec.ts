import { describe, expect, it, vi } from 'vitest';
import { ReconciliationRunService } from './reconciliation-run.service';
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
  triggeredBy: 'manual',
  recordsChecked: 0,
  discrepanciesFound: 0,
  discrepanciesRepaired: 0,
  error: null,
};

describe('ReconciliationRunService', () => {
  describe('startReconciliationRun()', () => {
    it('creates a running reconciliation run when the integration is connected and idle', async () => {
      const created = { ...runningRun };
      const client = {
        select: makeSelectQueue([[integration], []]),
        insert: vi.fn(() => makeChain([created])),
      };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      const result = await service.startReconciliationRun('ws_1', 'shopify', 'manual');

      expect(result).toEqual(created);
      expect(client.insert).toHaveBeenCalled();
    });

    it('throws NotFoundError when the workspace has no connection for that provider', async () => {
      const client = { select: makeSelectQueue([[]]) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await expect(service.startReconciliationRun('ws_1', 'shopify', 'manual')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('throws ConflictError when the integration is disconnected', async () => {
      const client = { select: makeSelectQueue([[{ id: 'int_1', status: 'disconnected' }]]) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await expect(service.startReconciliationRun('ws_1', 'shopify', 'scheduled')).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });

    it('throws ConflictError when a run is already in progress', async () => {
      const client = { select: makeSelectQueue([[integration], [{ id: 'run_0' }]]) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await expect(service.startReconciliationRun('ws_1', 'shopify', 'sync_completion')).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });
  });

  describe('recordProgress()', () => {
    it('updates counts on a running run, defaulting unset fields to current values', async () => {
      const updateChain = makeChain([{ ...runningRun, recordsChecked: 100, discrepanciesFound: 2 }]);
      const client = { select: makeSelectQueue([[runningRun]]), update: vi.fn(() => updateChain) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      const result = await service.recordProgress('run_1', { recordsChecked: 100, discrepanciesFound: 2 });

      expect(result).toMatchObject({ recordsChecked: 100, discrepanciesFound: 2 });
      expect(updateChain.set).toHaveBeenCalledWith({
        recordsChecked: 100,
        discrepanciesFound: 2,
        discrepanciesRepaired: 0,
      });
    });

    it('throws NotFoundError for an unknown run', async () => {
      const client = { select: makeSelectQueue([[]]) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await expect(service.recordProgress('missing', { recordsChecked: 1 })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('throws ConflictError when the run is not running', async () => {
      const client = { select: makeSelectQueue([[{ ...runningRun, status: 'succeeded' }]]) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await expect(service.recordProgress('run_1', { recordsChecked: 1 })).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });
  });

  describe('completeReconciliationRun()', () => {
    it('marks the run succeeded when no discrepancies were found', async () => {
      const updateChain = makeChain([{ ...runningRun, status: 'succeeded' }]);
      const client = { select: makeSelectQueue([[runningRun]]), update: vi.fn(() => updateChain) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await service.completeReconciliationRun('run_1');

      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.status).toBe('succeeded');
      expect(setArg.completedAt).toBeInstanceOf(Date);
    });

    it('marks the run succeeded when every discrepancy found was repaired', async () => {
      const fullyRepaired = { ...runningRun, discrepanciesFound: 3, discrepanciesRepaired: 3 };
      const updateChain = makeChain([{ ...fullyRepaired, status: 'succeeded' }]);
      const client = { select: makeSelectQueue([[fullyRepaired]]), update: vi.fn(() => updateChain) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await service.completeReconciliationRun('run_1');

      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.status).toBe('succeeded');
    });

    it('marks the run partial when some discrepancies remain unrepaired', async () => {
      const partiallyRepaired = { ...runningRun, discrepanciesFound: 3, discrepanciesRepaired: 1 };
      const updateChain = makeChain([{ ...partiallyRepaired, status: 'partial' }]);
      const client = { select: makeSelectQueue([[partiallyRepaired]]), update: vi.fn(() => updateChain) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await service.completeReconciliationRun('run_1');

      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.status).toBe('partial');
    });

    it('throws ConflictError when the run is not running', async () => {
      const client = { select: makeSelectQueue([[{ ...runningRun, status: 'failed' }]]) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await expect(service.completeReconciliationRun('run_1')).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  describe('failReconciliationRun()', () => {
    it('marks the run failed with the error message', async () => {
      const updateChain = makeChain([{ ...runningRun, status: 'failed', error: 'Provider timed out' }]);
      const client = { select: makeSelectQueue([[runningRun]]), update: vi.fn(() => updateChain) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      const result = await service.failReconciliationRun('run_1', 'Provider timed out');

      expect(result).toMatchObject({ status: 'failed', error: 'Provider timed out' });
      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.completedAt).toBeInstanceOf(Date);
    });

    it('throws NotFoundError for an unknown run', async () => {
      const client = { select: makeSelectQueue([[]]) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await expect(service.failReconciliationRun('missing', 'boom')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('getLatestReconciliationRun()', () => {
    it('returns the most recent run for the provider', async () => {
      const client = { select: makeSelectQueue([[integration], [runningRun]]) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await expect(service.getLatestReconciliationRun('ws_1', 'shopify')).resolves.toEqual(runningRun);
    });

    it('returns null when no run has ever started', async () => {
      const client = { select: makeSelectQueue([[integration], []]) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await expect(service.getLatestReconciliationRun('ws_1', 'shopify')).resolves.toBeNull();
    });

    it('throws NotFoundError when the workspace has no connection for that provider', async () => {
      const client = { select: makeSelectQueue([[]]) };
      const service = new ReconciliationRunService({ client } as unknown as DatabaseService);

      await expect(service.getLatestReconciliationRun('ws_1', 'shopify')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });
});
