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
import { and, eq } from 'drizzle-orm';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { integrations } from '../../database/schema/integrations';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { commerceProducts } from '../../database/schema/commerce-products';
import { commerceOrderLineItems } from '../../database/schema/commerce-order-line-items';
import { commerceRefundLineItems } from '../../database/schema/commerce-refund-line-items';
import { commerceFulfillments } from '../../database/schema/commerce-fulfillments';
import { commerceRefunds } from '../../database/schema/commerce-refunds';

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

  describe('disconnect()', () => {
    it('marks a connected integration as disconnected', async () => {
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
      expect(updateChain.set).toHaveBeenCalledWith({ status: 'disconnected', lastSyncError: null, credentials: null });
    });

    it('throws NotFoundError when the workspace has no connection for that provider', async () => {
      const client = { select: makeSelectQueue([[]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await expect(service.disconnect('ws_1', 'shopify')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('clears the stored provider credentials (Part 5B — DLP/incident response: a disconnect must not leave the old credential behind)', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: 'encrypted-blob' };
      const updateChain = makeChain([{ ...existing, status: 'disconnected', credentials: null }]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await service.disconnect('ws_1', 'shopify');

      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.credentials).toBeNull();
    });

    it('clears the status and the credentials in a single atomic update — not two separate writes', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: 'encrypted-blob' };
      const updateChain = makeChain([{ ...existing, status: 'disconnected', credentials: null }]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await service.disconnect('ws_1', 'shopify');

      expect(client.update).toHaveBeenCalledTimes(1);
      expect(updateChain.set).toHaveBeenCalledTimes(1);
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'disconnected', credentials: null }));
    });

    it('scopes the update to only the target integration, by id', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
      const updateChain = makeChain([{ ...existing, status: 'disconnected', credentials: null }]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await service.disconnect('ws_1', 'shopify');

      expect(updateChain.where).toHaveBeenCalledWith(eq(integrations.id, 'int_1'));
    });

    it('a still-connected integration is never touched by another integration\'s disconnect (no cross-row effect at the query level)', async () => {
      // The update's WHERE clause is scoped to this integration's id alone (verified above) — a second,
      // still-connected integration row is never part of the query this call issues, so it cannot be affected.
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
      const otherIntegrationId = 'int_2';
      const updateChain = makeChain([{ ...existing, status: 'disconnected', credentials: null }]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await service.disconnect('ws_1', 'shopify');

      const whereArg = (updateChain.where as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(whereArg).not.toEqual(eq(integrations.id, otherIntegrationId));
    });

    it('reconnecting after a disconnect can store fresh credentials (setCredentials always writes a new value, regardless of the cleared prior one)', async () => {
      const adapter = { verifyConnection: vi.fn(async () => true) };
      const disconnectedIntegration = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: null };
      const updateChain = makeChain([{ ...disconnectedIntegration, credentials: 'new-encrypted-blob' }]);
      const client = { select: makeSelectQueue([[disconnectedIntegration]]), update: vi.fn(() => updateChain) };
      const service = new IntegrationService(
        { client } as unknown as DatabaseService,
        makeConfig(),
        makeRegistry(adapter),
        makeImportRunService(),
        makeReconciliationRunService(),
        makeEventBus(),
      );

      await service.connectCredentials('ws_1', 'shopify', { accessToken: 'fresh-token' });

      expect(adapter.verifyConnection).toHaveBeenCalled();
      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(typeof setArg.credentials).toBe('string');
      expect(setArg.credentials).not.toBeNull();
    });
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

    it('getCredentials() does not touch the adapter when the stored credentials have no expiresAt', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: null };
      const setupChain = makeChain([existing]);
      const setupService = new IntegrationService(
        { client: { select: makeSelectQueue([[existing]]), update: vi.fn(() => setupChain) } } as unknown as DatabaseService,
        makeConfig(),
        makeRegistry(),
        makeImportRunService(),
        makeReconciliationRunService(),
        makeEventBus(),
      );
      await setupService.setCredentials('ws_1', 'shopify', { shopDomain: 'shop.myshopify.com', accessToken: 'shpat_manual' });
      const encrypted = (setupChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0].credentials as string;

      const adapter = { refreshCredentials: vi.fn() };
      const client = { select: makeSelectQueue([[{ ...existing, credentials: encrypted }]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(adapter), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      const result = await service.getCredentials('ws_1', 'shopify');

      expect(adapter.refreshCredentials).not.toHaveBeenCalled();
      expect(result).toEqual({ shopDomain: 'shop.myshopify.com', accessToken: 'shpat_manual' });
    });

    it('getCredentials() does not refresh when expiresAt is still comfortably in the future', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: null };
      const setupChain = makeChain([existing]);
      const setupService = new IntegrationService(
        { client: { select: makeSelectQueue([[existing]]), update: vi.fn(() => setupChain) } } as unknown as DatabaseService,
        makeConfig(),
        makeRegistry(),
        makeImportRunService(),
        makeReconciliationRunService(),
        makeEventBus(),
      );
      const fresh = {
        shopDomain: 'shop.myshopify.com',
        accessToken: 'shpca_fresh',
        grantType: 'client_credentials',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
      await setupService.setCredentials('ws_1', 'shopify', fresh);
      const encrypted = (setupChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0].credentials as string;

      const adapter = { refreshCredentials: vi.fn() };
      const client = { select: makeSelectQueue([[{ ...existing, credentials: encrypted }]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(adapter), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      const result = await service.getCredentials('ws_1', 'shopify');

      expect(adapter.refreshCredentials).not.toHaveBeenCalled();
      expect(result).toEqual(fresh);
    });

    it('getCredentials() refreshes and persists an expiring Shopify client-credentials token', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: null };
      const setupChain = makeChain([existing]);
      const setupService = new IntegrationService(
        { client: { select: makeSelectQueue([[existing]]), update: vi.fn(() => setupChain) } } as unknown as DatabaseService,
        makeConfig(),
        makeRegistry(),
        makeImportRunService(),
        makeReconciliationRunService(),
        makeEventBus(),
      );
      const stale = {
        shopDomain: 'shop.myshopify.com',
        accessToken: 'shpca_old',
        grantType: 'client_credentials',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      };
      await setupService.setCredentials('ws_1', 'shopify', stale);
      const encrypted = (setupChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0].credentials as string;

      const refreshed = {
        shopDomain: 'shop.myshopify.com',
        accessToken: 'shpca_new',
        grantType: 'client_credentials',
        expiresAt: new Date(Date.now() + 86_399_000).toISOString(),
      };
      const adapter = { refreshCredentials: vi.fn(async () => refreshed) };
      const storedRow = { ...existing, credentials: encrypted };
      const updateChain = makeChain([storedRow]);
      const client = { select: makeSelectQueue([[storedRow], [storedRow]]), update: vi.fn(() => updateChain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(adapter), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      const result = await service.getCredentials('ws_1', 'shopify');

      expect(adapter.refreshCredentials).toHaveBeenCalledWith(stale);
      expect(result).toEqual(refreshed);
      expect(client.update).toHaveBeenCalled();
    });

    it('getCredentials() falls back to the stale credentials when the adapter has no refreshCredentials (e.g. WooCommerce)', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'woocommerce', status: 'connected', credentials: null };
      const setupChain = makeChain([existing]);
      const setupService = new IntegrationService(
        { client: { select: makeSelectQueue([[existing]]), update: vi.fn(() => setupChain) } } as unknown as DatabaseService,
        makeConfig(),
        makeRegistry(),
        makeImportRunService(),
        makeReconciliationRunService(),
        makeEventBus(),
      );
      const stale = { consumerKey: 'ck_x', consumerSecret: 'cs_x', expiresAt: new Date(Date.now() - 1000).toISOString() };
      await setupService.setCredentials('ws_1', 'woocommerce', stale);
      const encrypted = (setupChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0].credentials as string;

      const client = { select: makeSelectQueue([[{ ...existing, credentials: encrypted }]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry({}), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await expect(service.getCredentials('ws_1', 'woocommerce')).resolves.toEqual(stale);
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

  describe('purgeCustomerData()', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    /**
     * Mocks the transaction-scoped `tx` the method receives. Only the
     * `commerce_customers` delete ever calls `.returning()` in the real
     * code, so that's the only delete result worth injecting; every
     * select is distinguished by the field name it selects (matches the
     * real query shapes: `canonicalCustomerId`, `count`, or `id`).
     */
    function makeTx(options: {
      linkedRows?: { canonicalCustomerId: string | null }[];
      remainingCounts?: number[];
      conversationRows?: { id: string }[][];
      commerceCustomersDeleted?: { id: string }[];
    } = {}) {
      const { linkedRows = [], remainingCounts = [], conversationRows = [], commerceCustomersDeleted = [] } = options;
      let remainingIdx = 0;
      let conversationIdx = 0;
      const deleteCalls: unknown[] = [];
      // Which `.where(...)` args each table's delete call used — additive to
      // deleteCalls above, so existing `toContain`/`not.toContain` assertions
      // on deleteCalls are untouched by this.
      const deleteWhereArgsByTable = new Map<unknown, unknown[][]>();

      function chain(result: unknown, whereArgsSink?: unknown[][]) {
        const c: Record<string, unknown> = {
          from: vi.fn(() => c),
          where: vi.fn((...args: unknown[]) => {
            whereArgsSink?.push(args);
            return c;
          }),
          returning: vi.fn(async () => result ?? []),
          then: (resolve: (v: unknown) => void) => resolve(result ?? []),
        };
        return c;
      }

      const select = vi.fn((fields: Record<string, unknown>) => {
        if ('canonicalCustomerId' in fields) return chain(linkedRows);
        if ('count' in fields) return chain([{ count: remainingCounts[remainingIdx++] ?? 0 }]);
        return chain(conversationRows[conversationIdx++] ?? []);
      });

      const del = vi.fn((table: unknown) => {
        deleteCalls.push(table);
        const whereArgsSink: unknown[][] = [];
        deleteWhereArgsByTable.set(table, whereArgsSink);
        return chain(table === commerceCustomers ? commerceCustomersDeleted : [], whereArgsSink);
      });

      return { select, delete: del, deleteCalls, deleteWhereArgsByTable };
    }

    function makeService(existingIntegration: Record<string, unknown> | null, tx: ReturnType<typeof makeTx>) {
      const client = { select: makeSelectQueue([existingIntegration ? [existingIntegration] : []]) };
      const database = {
        client,
        transaction: vi.fn((fn: (tx: unknown) => unknown) => fn({ select: tx.select, delete: tx.delete })),
      };
      return new IntegrationService(
        database as unknown as DatabaseService,
        makeConfig(),
        makeRegistry(),
        makeImportRunService(),
        makeReconciliationRunService(),
        makeEventBus(),
      );
    }

    it('throws NotFoundError when the workspace has no connection for that provider', async () => {
      const tx = makeTx();
      const service = makeService(null, tx);

      await expect(service.purgeCustomerData('ws_1', 'shopify')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws ConflictError when the integration is still connected', async () => {
      const integration = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', updatedAt: new Date(Date.now() - 200 * DAY_MS) };
      const tx = makeTx();
      const service = makeService(integration, tx);

      await expect(service.purgeCustomerData('ws_1', 'shopify')).rejects.toThrow('Only a disconnected integration can have its customer data purged.');
      expect(tx.select).not.toHaveBeenCalled();
    });

    it('throws ConflictError when disconnected but the retention period has not elapsed', async () => {
      const integration = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'disconnected', updatedAt: new Date(Date.now() - 5 * DAY_MS) };
      const tx = makeTx();
      const service = makeService(integration, tx);

      await expect(service.purgeCustomerData('ws_1', 'shopify')).rejects.toThrow(/retention period has not elapsed yet/);
      expect(tx.select).not.toHaveBeenCalled();
    });

    it('purges commerce data for a disconnected integration past its retention period', async () => {
      const integration = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'disconnected', updatedAt: new Date(Date.now() - 91 * DAY_MS) };
      const tx = makeTx({ linkedRows: [], commerceCustomersDeleted: [] });
      const service = makeService(integration, tx);

      const result = await service.purgeCustomerData('ws_1', 'shopify');

      expect(result).toEqual({ integrationId: 'int_1', commerceCustomersRemoved: 0, canonicalCustomersRemoved: 0 });
      expect(tx.deleteCalls).toContain(commerceCustomers);
    });

    it('preserves a canonical customer that still has commerce_customers rows from another integration', async () => {
      const integration = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'disconnected', updatedAt: new Date(Date.now() - 91 * DAY_MS) };
      const tx = makeTx({
        linkedRows: [{ canonicalCustomerId: 'canon_1' }],
        remainingCounts: [1], // still referenced by a commerce_customers row from a different (still-connected) integration
        commerceCustomersDeleted: [{ id: 'cc_1' }],
      });
      const service = makeService(integration, tx);

      const result = await service.purgeCustomerData('ws_1', 'shopify');

      expect(result).toEqual({ integrationId: 'int_1', commerceCustomersRemoved: 1, canonicalCustomersRemoved: 0 });
      expect(tx.deleteCalls).not.toContain(canonicalCustomers);
    });

    it('removes a canonical customer left with no remaining source records after the purge', async () => {
      const integration = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'disconnected', updatedAt: new Date(Date.now() - 91 * DAY_MS) };
      const tx = makeTx({
        linkedRows: [{ canonicalCustomerId: 'canon_1' }],
        remainingCounts: [0], // no other integration's commerce_customers references it anymore
        conversationRows: [[]],
        commerceCustomersDeleted: [{ id: 'cc_1' }],
      });
      const service = makeService(integration, tx);

      const result = await service.purgeCustomerData('ws_1', 'shopify');

      expect(result).toEqual({ integrationId: 'int_1', commerceCustomersRemoved: 1, canonicalCustomersRemoved: 1 });
      expect(tx.deleteCalls).toContain(canonicalCustomers);
    });

    it('running the purge twice is safe — the second run finds nothing left and is a no-op', async () => {
      const integration = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'disconnected', updatedAt: new Date(Date.now() - 91 * DAY_MS) };
      const tx = makeTx({ linkedRows: [], commerceCustomersDeleted: [] });
      const service = makeService(integration, tx);

      await expect(service.purgeCustomerData('ws_1', 'shopify')).resolves.toEqual({
        integrationId: 'int_1',
        commerceCustomersRemoved: 0,
        canonicalCustomersRemoved: 0,
      });
    });

    it('removes integration_webhook_events belonging to the purged integration (DLP — raw webhook payloads carry customer PII)', async () => {
      const integration = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'disconnected', updatedAt: new Date(Date.now() - 91 * DAY_MS) };
      const tx = makeTx({ linkedRows: [], commerceCustomersDeleted: [] });
      const service = makeService(integration, tx);

      await service.purgeCustomerData('ws_1', 'shopify');

      expect(tx.deleteCalls).toContain(integrationWebhookEvents);
    });

    it('scopes the integration_webhook_events delete to this workspace + this integration only, leaving other integrations\' events untouched', async () => {
      const integration = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'disconnected', updatedAt: new Date(Date.now() - 91 * DAY_MS) };
      const tx = makeTx({ linkedRows: [], commerceCustomersDeleted: [] });
      const service = makeService(integration, tx);

      await service.purgeCustomerData('ws_1', 'shopify');

      const whereArgs = tx.deleteWhereArgsByTable.get(integrationWebhookEvents);
      expect(whereArgs).toHaveLength(1);
      expect(whereArgs?.[0][0]).toEqual(and(eq(integrationWebhookEvents.workspaceId, 'ws_1'), eq(integrationWebhookEvents.integrationId, 'int_1')));
    });
  });

  describe('findByShopDomain()', () => {
    it('resolves the most recently updated integration for that shop domain', async () => {
      const row = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', shopDomain: 'wavyfyy.myshopify.com' };
      const chain = makeChain([row]);
      const client = { select: vi.fn(() => chain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      const result = await service.findByShopDomain('wavyfyy.myshopify.com');

      expect(result).toEqual(row);
    });

    it('returns null when no integration has that shop domain', async () => {
      const chain = makeChain([]);
      const client = { select: vi.fn(() => chain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await expect(service.findByShopDomain('unknown.myshopify.com')).resolves.toBeNull();
    });
  });

  describe('purgeCommerceCustomer() — Shopify customers/redact', () => {
    /** Sequential select results (call order: customerRow, orderRows, [refundRows], [canonical remaining count], [conversationRows]); deletes are tracked by table identity, matching purgeCustomerData()'s test style above. */
    function makeTx(selectResults: unknown[]) {
      const select = makeSelectQueue(selectResults);
      const deleteCalls: unknown[] = [];
      const del = vi.fn((table: unknown) => {
        deleteCalls.push(table);
        return makeChain([]);
      });
      return { select, delete: del, deleteCalls };
    }

    function makeService(tx: ReturnType<typeof makeTx>) {
      const database = { transaction: vi.fn((fn: (tx: unknown) => unknown) => fn({ select: tx.select, delete: tx.delete })) };
      return new IntegrationService(database as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());
    }

    it('returns found: false and deletes nothing when the externalId does not exist in this integration', async () => {
      const tx = makeTx([[]]); // customerRow lookup -> not found
      const service = makeService(tx);

      const result = await service.purgeCommerceCustomer('ws_1', 'int_1', 'shopify_customer_999');

      expect(result).toEqual({ found: false, canonicalCustomerRemoved: false });
      expect(tx.deleteCalls).toHaveLength(0);
    });

    it('erases the customer\'s orders/commerce profile and preserves a canonical customer still referenced elsewhere', async () => {
      const tx = makeTx([
        [{ id: 'cc_1', canonicalCustomerId: 'canon_1' }], // customerRow
        [{ id: 'order_1' }], // orderRows
        [{ id: 'refund_1' }], // refundRows
        [{ count: 1 }], // canonical orphan check — still referenced by another commerce_customers row
      ]);
      const service = makeService(tx);

      const result = await service.purgeCommerceCustomer('ws_1', 'int_1', 'shopify_customer_1');

      expect(result).toEqual({ found: true, canonicalCustomerRemoved: false });
      expect(tx.deleteCalls).toEqual(
        expect.arrayContaining([commerceOrderLineItems, commerceRefundLineItems, commerceFulfillments, commerceRefunds, commerceOrders, commerceCustomers]),
      );
      expect(tx.deleteCalls).not.toContain(canonicalCustomers);
    });

    it('removes the canonical customer once it is left orphaned', async () => {
      const tx = makeTx([
        [{ id: 'cc_1', canonicalCustomerId: 'canon_1' }], // customerRow
        [], // orderRows — no orders for this customer
        [{ count: 0 }], // canonical orphan check — nothing else references it
        [], // conversationRows
      ]);
      const service = makeService(tx);

      const result = await service.purgeCommerceCustomer('ws_1', 'int_1', 'shopify_customer_1');

      expect(result).toEqual({ found: true, canonicalCustomerRemoved: true });
      expect(tx.deleteCalls).toContain(commerceCustomers);
      expect(tx.deleteCalls).toContain(canonicalCustomers);
    });

    it('does not touch the canonical-customer cascade when the commerce customer has no canonical link yet', async () => {
      const tx = makeTx([
        [{ id: 'cc_1', canonicalCustomerId: null }], // customerRow, not yet identity-resolved
        [], // orderRows
      ]);
      const service = makeService(tx);

      const result = await service.purgeCommerceCustomer('ws_1', 'int_1', 'shopify_customer_1');

      expect(result).toEqual({ found: true, canonicalCustomerRemoved: false });
      expect(tx.deleteCalls).not.toContain(canonicalCustomers);
    });
  });

  describe('eraseIntegrationForShopRedact() — Shopify shop/redact', () => {
    function makeTx(integrationRow: Record<string, unknown> | null, extraSelectResults: unknown[] = []) {
      const select = makeSelectQueue([integrationRow ? [integrationRow] : [], ...extraSelectResults]);
      const deleteCalls: unknown[] = [];
      const del = vi.fn((table: unknown) => {
        deleteCalls.push(table);
        return makeChain([]);
      });
      const updateChain = makeChain([{ ...integrationRow, status: 'disconnected', credentials: null, shopDomain: null }]);
      const update = vi.fn(() => updateChain);
      return { select, delete: del, update, deleteCalls, updateChain };
    }

    function makeService(tx: ReturnType<typeof makeTx>) {
      const database = { transaction: vi.fn((fn: (tx: unknown) => unknown) => fn({ select: tx.select, delete: tx.delete, update: tx.update })) };
      return new IntegrationService(database as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());
    }

    it('returns found: false and touches nothing for a nonexistent integration id', async () => {
      const tx = makeTx(null);
      const service = makeService(tx);

      const result = await service.eraseIntegrationForShopRedact('int_missing');

      expect(result).toEqual({ found: false });
      expect(tx.deleteCalls).toHaveLength(0);
      expect(tx.update).not.toHaveBeenCalled();
    });

    it('erases commerce data, catalog data, and disconnects + clears credentials and shopDomain', async () => {
      const integration = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: 'encrypted-blob', shopDomain: 'wavyfyy.myshopify.com' };
      // purgeIntegrationCommerceData's own selects: linked (canonicalCustomerId) rows, then none candidate → no further selects.
      const tx = makeTx(integration, [[]]);
      const service = makeService(tx);

      const result = await service.eraseIntegrationForShopRedact('int_1');

      expect(result).toEqual({ found: true });
      expect(tx.deleteCalls).toContain(commerceProducts);
      expect(tx.update).toHaveBeenCalledWith(integrations);
      expect(tx.updateChain.set).toHaveBeenCalledWith({ status: 'disconnected', lastSyncError: null, credentials: null, shopDomain: null });
    });
  });

  describe('setCredentials() — shopDomain plaintext column', () => {
    it('writes shopDomain alongside the encrypted credentials when the payload carries one', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
      const updateChain = makeChain([existing]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await service.setCredentials('ws_1', 'shopify', { shopDomain: 'wavyfyy.myshopify.com', accessToken: 'shpat_secret' });

      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(setArg.shopDomain).toBe('wavyfyy.myshopify.com');
    });

    it('does not touch shopDomain when the credential payload has none', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'woocommerce', status: 'connected' };
      const updateChain = makeChain([existing]);
      const client = { select: makeSelectQueue([[existing]]), update: vi.fn(() => updateChain) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig(), makeRegistry(), makeImportRunService(), makeReconciliationRunService(), makeEventBus());

      await service.setCredentials('ws_1', 'woocommerce', { siteUrl: 'https://example.com', consumerKey: 'ck_1', consumerSecret: 'cs_1' });

      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(setArg)).not.toContain('shopDomain');
    });
  });
});
