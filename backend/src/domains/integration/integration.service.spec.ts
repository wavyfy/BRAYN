import { describe, expect, it, vi } from 'vitest';
import { IntegrationService } from './integration.service';
import type { DatabaseService } from '../../database/database.service';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import type { ProviderRegistry } from './provider-registry.service';
import type { ProviderAdapter } from './provider-adapter.interface';
import type { ImportRunService } from './import-run.service';
import type { ReconciliationRunService } from './reconciliation-run.service';
import type { EventBus } from '../../common/events/event-bus.service';

const VALID_KEY = 'a'.repeat(64);

function makeConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const env: Partial<Env> = { BRAYN_CREDENTIAL_ENCRYPTION_KEY: VALID_KEY, ...overrides };
  return { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
}

/** Only connectCredentials() touches the registry — other tests never call get(), so a stub is fine. */
function makeRegistry(adapter?: Partial<ProviderAdapter>): ProviderRegistry {
  return { get: vi.fn(() => adapter) } as unknown as ProviderRegistry;
}

/** Only startInitialImport() touches these — other tests never call them, so stubs are fine. */
function makeImportRunService(): ImportRunService {
  return { startImportRun: vi.fn() } as unknown as ImportRunService;
}

function makeEventBus(): EventBus {
  return { emit: vi.fn() } as unknown as EventBus;
}

/** Only startReconciliation() touches this — other tests never call it, so a stub is fine. */
function makeReconciliationRunService(): ReconciliationRunService {
  return { startReconciliationRun: vi.fn() } as unknown as ReconciliationRunService;
}

function makeChain(finalResult: unknown) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    set: vi.fn(() => chain),
    returning: vi.fn(async () => finalResult),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => finalResult),
    then: (resolve: (value: unknown) => void) => resolve(finalResult),
  };
  return chain;
}

function makeSelectQueue(results: unknown[]) {
  let i = 0;
  return vi.fn(() => makeChain(results[i++]));
}

describe('IntegrationService', () => {
  it('listByWorkspace() returns integrations for the workspace', async () => {
    const rows = [{ id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' }];
    const chain = makeChain(rows);
    const client = { select: vi.fn(() => chain) };
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

    const result = await service.listByWorkspace('ws_1');

    expect(result).toEqual(rows);
  });

  it('connect() inserts a new connected integration when none exists', async () => {
    const created = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
    const client = {
      select: makeSelectQueue([[]]),
      insert: vi.fn(() => makeChain([created])),
    };
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

    const result = await service.connect('ws_1', 'shopify');

    expect(result).toEqual(created);
    expect(client.insert).toHaveBeenCalled();
  });

  it('connect() throws ConflictError when the provider is already connected', async () => {
    const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
    const client = { select: makeSelectQueue([[existing]]) };
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

    await expect(service.connect('ws_1', 'shopify')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('connect() reconnects a previously disconnected integration', async () => {
    const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'disconnected' };
    const reconnected = { ...existing, status: 'connected' };
    const updateChain = makeChain([reconnected]);
    const client = {
      select: makeSelectQueue([[existing]]),
      update: vi.fn(() => updateChain),
    };
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

    const result = await service.connect('ws_1', 'shopify');

    expect(result).toEqual(reconnected);
    expect(updateChain.set).toHaveBeenCalledWith({ status: 'connected', lastSyncError: null });
  });

  it('connect() throws ConflictError when the provider is mid-sync', async () => {
    const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'syncing' };
    const client = { select: makeSelectQueue([[existing]]) };
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

    await expect(service.connect('ws_1', 'shopify')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('connect() throws ConflictError when the provider is in an error state', async () => {
    const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'error' };
    const client = { select: makeSelectQueue([[existing]]) };
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

    await expect(service.connect('ws_1', 'shopify')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('disconnect() marks a connected integration as disconnected', async () => {
    const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
    const disconnected = { ...existing, status: 'disconnected' };
    const updateChain = makeChain([disconnected]);
    const client = {
      select: makeSelectQueue([[existing]]),
      update: vi.fn(() => updateChain),
    };
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

    const result = await service.disconnect('ws_1', 'shopify');

    expect(result).toEqual(disconnected);
    expect(updateChain.set).toHaveBeenCalledWith({ status: 'disconnected', lastSyncError: null });
  });

  it('disconnect() throws NotFoundError when the workspace has no connection for that provider', async () => {
    const client = { select: makeSelectQueue([[]]) };
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

    await expect(service.disconnect('ws_1', 'shopify')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  describe('connectCredentials()', () => {
    it('verifies via the registered adapter, then stores the credentials encrypted', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: null };
      const updateChain = makeChain([existing]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const verifyConnection = vi.fn(async () => true);
      const service = new IntegrationService(
        { client } as unknown as DatabaseService,
        makeConfig(),
        makeRegistry({ verifyConnection }),
        makeImportRunService(),
        makeReconciliationRunService(),
        makeEventBus(),
      );

      await service.connectCredentials('ws_1', 'shopify', { accessToken: 'shpat_secret' });

      expect(verifyConnection).toHaveBeenCalledWith({ accessToken: 'shpat_secret' });
      const stored = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0].credentials as string;
      expect(stored).not.toContain('shpat_secret');
    });

    it('throws UnauthenticatedError and stores nothing when the adapter rejects the credentials', async () => {
      const client = { select: vi.fn(), update: vi.fn() };
      const verifyConnection = vi.fn(async () => false);
      const service = new IntegrationService(
        { client } as unknown as DatabaseService,
        makeConfig(),
        makeRegistry({ verifyConnection }),
        makeImportRunService(),
        makeReconciliationRunService(),
        makeEventBus(),
      );

      await expect(service.connectCredentials('ws_1', 'shopify', { accessToken: 'bad' })).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
      expect(client.select).not.toHaveBeenCalled();
      expect(client.update).not.toHaveBeenCalled();
    });

    it('propagates ProviderError when no adapter is registered for the provider', async () => {
      const client = { select: vi.fn() };
      const registry = {
        get: vi.fn(() => {
          const err = new Error('No adapter is registered') as Error & { code: string };
          err.code = 'PROVIDER_ERROR';
          throw err;
        }),
      } as unknown as ProviderRegistry;
      const service = new IntegrationService(
        { client } as unknown as DatabaseService,
        makeConfig(),
        registry,
        makeImportRunService(),
        makeReconciliationRunService(),
        makeEventBus(),
      );

      await expect(service.connectCredentials('ws_1', 'shopify', { accessToken: 'x' })).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      });
    });
  });

  describe('startInitialImport()', () => {
    it('starts a run via ImportRunService and emits integration.import.requested', async () => {
      const run = { id: 'run_1', workspaceId: 'ws_1', integrationId: 'int_1', status: 'running' };
      const importRunService = { startImportRun: vi.fn(async () => run) } as unknown as ImportRunService;
      const eventBus = { emit: vi.fn() } as unknown as EventBus;
      const service = new IntegrationService(
        {} as unknown as DatabaseService,
        makeConfig(),
        makeRegistry({ fetchCustomers: vi.fn() }),
        importRunService,
        makeReconciliationRunService(),
        eventBus,
      );

      const result = await service.startInitialImport('ws_1', 'shopify');

      expect(result).toEqual(run);
      expect(importRunService.startImportRun).toHaveBeenCalledWith('ws_1', 'shopify');
      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'integration.import.requested',
          workspaceId: 'ws_1',
          entityId: 'int_1',
          payload: { provider: 'shopify', runId: 'run_1' },
        }),
      );
    });

    it('throws ProviderError without starting a run when the adapter does not support customer import', async () => {
      const importRunService = { startImportRun: vi.fn() } as unknown as ImportRunService;
      const eventBus = { emit: vi.fn() } as unknown as EventBus;
      const service = new IntegrationService(
        {} as unknown as DatabaseService,
        makeConfig(),
        makeRegistry({}),
        importRunService,
        makeReconciliationRunService(),
        eventBus,
      );

      await expect(service.startInitialImport('ws_1', 'shopify')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(importRunService.startImportRun).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  describe('startSync() / completeSync() / failSync()', () => {
    it('startSync() moves a connected integration to syncing', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
      const syncing = { ...existing, status: 'syncing' };
      const updateChain = makeChain([syncing]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      const result = await service.startSync('ws_1', 'shopify');

      expect(result).toEqual(syncing);
      expect(updateChain.set).toHaveBeenCalledWith({ status: 'syncing', lastSyncError: null });
    });

    it('startSync() allows retrying from an error state', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'error' };
      const updateChain = makeChain([{ ...existing, status: 'syncing' }]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await expect(service.startSync('ws_1', 'shopify')).resolves.toMatchObject({ status: 'syncing' });
    });

    it('startSync() throws ConflictError when the integration is disconnected', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'disconnected' };
      const client = { select: makeSelectQueue([[existing]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await expect(service.startSync('ws_1', 'shopify')).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('startSync() throws ConflictError when a sync is already in progress', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'syncing' };
      const client = { select: makeSelectQueue([[existing]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await expect(service.startSync('ws_1', 'shopify')).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('startSync() throws NotFoundError when the workspace has no connection for that provider', async () => {
      const client = { select: makeSelectQueue([[]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await expect(service.startSync('ws_1', 'shopify')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('completeSync() moves a syncing integration back to connected and stamps lastSyncedAt', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'syncing' };
      const completed = { ...existing, status: 'connected', lastSyncedAt: new Date('2026-09-01T00:00:00Z') };
      const updateChain = makeChain([completed]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      const result = await service.completeSync('ws_1', 'shopify');

      expect(result).toEqual(completed);
      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).toMatchObject({ status: 'connected', lastSyncError: null });
      expect(setArg.lastSyncedAt).toBeInstanceOf(Date);
    });

    it('completeSync() throws ConflictError when no sync is in progress', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
      const client = { select: makeSelectQueue([[existing]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await expect(service.completeSync('ws_1', 'shopify')).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('failSync() moves a syncing integration to error with the failure message', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'syncing' };
      const failed = { ...existing, status: 'error', lastSyncError: 'Provider timed out' };
      const updateChain = makeChain([failed]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      const result = await service.failSync('ws_1', 'shopify', 'Provider timed out');

      expect(result).toEqual(failed);
      expect(updateChain.set).toHaveBeenCalledWith({ status: 'error', lastSyncError: 'Provider timed out' });
    });

    it('failSync() throws ConflictError when no sync is in progress', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
      const client = { select: makeSelectQueue([[existing]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await expect(service.failSync('ws_1', 'shopify', 'boom')).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  describe('startIncrementalSync()', () => {
    it('starts a sync via startSync() and emits integration.sync.requested using the previous lastSyncedAt as the cursor', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', lastSyncedAt: new Date('2026-08-01T00:00:00Z') };
      const syncing = { ...existing, status: 'syncing' };
      const updateChain = makeChain([syncing]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const eventBus = { emit: vi.fn() } as unknown as EventBus;
      const service = new IntegrationService(
        { client } as unknown as DatabaseService,
        makeConfig(),
        makeRegistry({ fetchCustomers: vi.fn() }),
        makeImportRunService(),
        makeReconciliationRunService(),
        eventBus,
      );

      const result = await service.startIncrementalSync('ws_1', 'shopify');

      expect(result).toEqual(syncing);
      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'integration.sync.requested',
          workspaceId: 'ws_1',
          entityId: 'int_1',
          payload: { provider: 'shopify', updatedAtMin: '2026-08-01T00:00:00.000Z' },
        }),
      );
    });

    it('falls back to createdAt as the cursor when this integration has never completed a sync', async () => {
      const existing = {
        id: 'int_1',
        workspaceId: 'ws_1',
        provider: 'shopify',
        status: 'connected',
        lastSyncedAt: null,
        createdAt: new Date('2026-07-01T00:00:00Z'),
      };
      const updateChain = makeChain([{ ...existing, status: 'syncing' }]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const eventBus = { emit: vi.fn() } as unknown as EventBus;
      const service = new IntegrationService(
        { client } as unknown as DatabaseService,
        makeConfig(),
        makeRegistry({ fetchCustomers: vi.fn() }),
        makeImportRunService(),
        makeReconciliationRunService(),
        eventBus,
      );

      await service.startIncrementalSync('ws_1', 'shopify');

      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { provider: 'shopify', updatedAtMin: '2026-07-01T00:00:00.000Z' } }),
      );
    });

    it('throws ProviderError without starting a sync when the adapter does not support customer sync', async () => {
      const eventBus = { emit: vi.fn() } as unknown as EventBus;
      const client = { select: vi.fn() };
      const service = new IntegrationService(
        { client } as unknown as DatabaseService,
        makeConfig(),
        makeRegistry({}),
        makeImportRunService(),
        makeReconciliationRunService(),
        eventBus,
      );

      await expect(service.startIncrementalSync('ws_1', 'shopify')).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
      expect(client.select).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });

  describe('setCredentials() / getCredentials()', () => {
    it('encrypts on set and decrypts back the same payload on get', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: null };
      const updateChain = makeChain([existing]);
      const client = {
        select: makeSelectQueue([[existing]]),
        update: vi.fn(() => updateChain),
      };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await service.setCredentials('ws_1', 'shopify', { accessToken: 'shpat_secret' });

      const stored = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0].credentials as string;
      expect(stored).not.toContain('shpat_secret');

      const client2 = { select: makeSelectQueue([[{ ...existing, credentials: stored }]]) };
      const service2 = new IntegrationService({ client: client2 } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await expect(service2.getCredentials('ws_1', 'shopify')).resolves.toEqual({ accessToken: 'shpat_secret' });
    });

    it('setCredentials() throws NotFoundError when the workspace has no connection for that provider', async () => {
      const client = { select: makeSelectQueue([[]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await expect(service.setCredentials('ws_1', 'shopify', { accessToken: 'x' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('getCredentials() returns null when no credentials have been stored yet', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: null };
      const client = { select: makeSelectQueue([[existing]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await expect(service.getCredentials('ws_1', 'shopify')).resolves.toBeNull();
    });

    it('setCredentials() fails closed when the encryption key is missing', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: null };
      const client = { select: makeSelectQueue([[existing]]) };
      const service = new IntegrationService(
        { client } as unknown as DatabaseService,
        makeConfig({ BRAYN_CREDENTIAL_ENCRYPTION_KEY: undefined }),
        makeRegistry(),
        makeImportRunService(),
        makeReconciliationRunService(),
        makeEventBus(),
      );

      await expect(service.setCredentials('ws_1', 'shopify', { accessToken: 'x' })).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      });
    });

    it('setCredentials() fails closed when the encryption key is malformed', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: null };
      const client = { select: makeSelectQueue([[existing]]) };
      const service = new IntegrationService(
        { client } as unknown as DatabaseService,
        makeConfig({ BRAYN_CREDENTIAL_ENCRYPTION_KEY: 'not-hex-and-wrong-length' }),
        makeRegistry(),
        makeImportRunService(),
        makeReconciliationRunService(),
        makeEventBus(),
      );

      await expect(service.setCredentials('ws_1', 'shopify', { accessToken: 'x' })).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      });
    });
  });

  describe('credential column exclusion', () => {
    it('listByWorkspace() never selects the credentials column', async () => {
      const chain = makeChain([]);
      const selectMock = vi.fn(() => chain);
      const client = { select: selectMock };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await service.listByWorkspace('ws_1');

      const selected = (selectMock.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(selected).not.toHaveProperty('credentials');
    });

    it('connect() never returns the credentials column', async () => {
      const created = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
      const insertChain = makeChain([created]);
      const client = {
        select: makeSelectQueue([[]]),
        insert: vi.fn(() => insertChain),
      };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await service.connect('ws_1', 'shopify');

      const returningArg = (insertChain.returning as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(returningArg).not.toHaveProperty('credentials');
    });
  });
});
