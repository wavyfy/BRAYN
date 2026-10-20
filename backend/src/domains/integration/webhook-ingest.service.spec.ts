import { describe, expect, it, vi } from 'vitest';
import { WebhookIngestService } from './webhook-ingest.service';
import type { DatabaseService } from '../../database/database.service';
import type { IntegrationService } from './integration.service';
import type { ProviderRegistry } from './provider-registry.service';
import type { EventBus } from '../../common/events/event-bus.service';
import type { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import type { ProviderAdapter } from './provider-adapter.interface';

function makeChain(finalResult: unknown) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
    set: vi.fn(() => chain),
    returning: vi.fn(async () => finalResult),
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
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

const integration = { id: 'int_1', status: 'connected' };

function makeAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    provider: 'shopify',
    verifyConnection: vi.fn(async () => true),
    verifyWebhookSignature: vi.fn(() => true),
    parseWebhookEvent: vi.fn(() => ({ externalEventId: 'evt_1', eventType: 'orders/create', payload: { id: 1 } })),
    ...overrides,
  };
}

function makeDeps(overrides: {
  select?: unknown[];
  adapter?: ProviderAdapter | null;
  credentials?: Record<string, string> | null;
  /** What the conflict-tolerant insert returns: a new row, or [] for an existing delivery. */
  insertResult?: unknown[];
  insertThrows?: Error;
  updateResult?: unknown[];
  emit?: () => void;
} = {}) {
  const insertChain = makeChain(overrides.insertResult ?? [{ id: 'wh_1' }]);
  if (overrides.insertThrows) {
    const error = overrides.insertThrows;
    insertChain.returning = vi.fn(async () => {
      throw error;
    });
  }
  const updateChain = makeChain(overrides.updateResult ?? []);
  const client = {
    select: makeSelectQueue(overrides.select ?? [[integration]]),
    insert: vi.fn(() => insertChain),
    update: vi.fn(() => updateChain),
  };

  const integrationService = {
    getCredentials: vi.fn(async () => (overrides.credentials === undefined ? { webhookSecret: 'shh' } : overrides.credentials)),
  } as unknown as IntegrationService;

  const providerRegistry = {
    get: vi.fn(() => {
      if (overrides.adapter === null) {
        const err = new Error('No adapter is registered') as Error & { code: string };
        err.code = 'PROVIDER_ERROR';
        throw err;
      }
      return overrides.adapter ?? makeAdapter();
    }),
  } as unknown as ProviderRegistry;

  const eventBus = { emit: overrides.emit ?? vi.fn() } as unknown as EventBus;
  const logger = { event: vi.fn() } as unknown as StructuredLoggerService;

  const service = new WebhookIngestService(
    { client } as unknown as DatabaseService,
    integrationService,
    providerRegistry,
    eventBus,
    logger,
  );

  return { service, client, integrationService, providerRegistry, eventBus, logger, insertChain, updateChain };
}

describe('WebhookIngestService', () => {
  it('accepts a valid, new delivery once its row is persisted, then emits a wake-up naming that row', async () => {
    const { service, eventBus, insertChain, client } = makeDeps();

    const result = await service.ingest('ws_1', 'shopify', '{}', { 'x-signature': 'sig' });

    expect(result).toEqual({ status: 'accepted', webhookEventId: 'wh_1' });
    expect((insertChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws_1',
      integrationId: 'int_1',
      externalEventId: 'evt_1',
      eventType: 'orders/create',
      payload: { id: 1 },
    });
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'integration.webhook.received',
        workspaceId: 'ws_1',
        entityId: 'int_1',
        payload: { webhookEventId: 'wh_1' },
      }),
    );
    // Persisting is the acknowledgement — ingest never marks the row processed itself.
    expect(client.update).not.toHaveBeenCalled();
  });

  it('dedupes on the (integrationId, externalEventId) unique index', async () => {
    const { service, insertChain } = makeDeps();

    await service.ingest('ws_1', 'shopify', '{}', {});

    const conflict = (insertChain.onConflictDoNothing as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(conflict.target).toHaveLength(2);
  });

  it('acknowledges a redelivery as duplicate without emitting (the existing row is already durably owned)', async () => {
    const { service, eventBus } = makeDeps({ insertResult: [] });

    const result = await service.ingest('ws_1', 'shopify', '{}', {});

    expect(result).toEqual({ status: 'duplicate' });
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('still accepts (row is durable) when the wake-up emit throws, and logs it', async () => {
    const { service, logger } = makeDeps({
      emit: vi.fn(() => {
        throw new Error('listener exploded');
      }),
    });

    const result = await service.ingest('ws_1', 'shopify', '{}', {});

    expect(result).toEqual({ status: 'accepted', webhookEventId: 'wh_1' });
    expect(logger.event).toHaveBeenCalledWith('warn', expect.any(String), 'WebhookIngestService', expect.objectContaining({ webhookEventId: 'wh_1' }));
  });

  it('throws (non-2xx, provider retries) when the row cannot be persisted, and emits nothing', async () => {
    const boom = new Error('insert failed');
    const { service, eventBus } = makeDeps({ insertThrows: boom });

    await expect(service.ingest('ws_1', 'shopify', '{}', {})).rejects.toThrow(boom);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the workspace has no connection for that provider', async () => {
    const { service } = makeDeps({ select: [[]] });

    await expect(service.ingest('ws_1', 'shopify', '{}', {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws ConflictError when the integration is disconnected', async () => {
    const { service } = makeDeps({ select: [[{ id: 'int_1', status: 'disconnected' }]] });

    await expect(service.ingest('ws_1', 'shopify', '{}', {})).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('propagates ProviderError when no adapter is registered', async () => {
    const { service } = makeDeps({ adapter: null });

    await expect(service.ingest('ws_1', 'shopify', '{}', {})).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('throws ProviderError when the adapter does not support webhooks', async () => {
    const { service } = makeDeps({
      adapter: makeAdapter({ verifyWebhookSignature: undefined, parseWebhookEvent: undefined }),
    });

    await expect(service.ingest('ws_1', 'shopify', '{}', {})).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('throws ProviderError when no webhook secret is configured', async () => {
    const { service } = makeDeps({ credentials: null });

    await expect(service.ingest('ws_1', 'shopify', '{}', {})).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('throws ProviderError when stored credentials have no webhookSecret field', async () => {
    const { service } = makeDeps({ credentials: { accessToken: 'tok' } });

    await expect(service.ingest('ws_1', 'shopify', '{}', {})).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });

  it('throws UnauthenticatedError when signature verification fails, persisting nothing', async () => {
    const { service, client } = makeDeps({ adapter: makeAdapter({ verifyWebhookSignature: vi.fn(() => false) }) });

    await expect(service.ingest('ws_1', 'shopify', '{}', {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('returns ignored (and persists nothing) when the adapter does not recognize the payload', async () => {
    const { service, client } = makeDeps({ adapter: makeAdapter({ parseWebhookEvent: vi.fn(() => null) }) });

    const result = await service.ingest('ws_1', 'shopify', '{}', {});

    expect(result).toEqual({ status: 'ignored' });
    expect(client.insert).not.toHaveBeenCalled();
  });

  describe('replay()', () => {
    it('requeues a dead-lettered row as pending with a fresh attempt budget, then wakes the processor', async () => {
      const { service, eventBus, updateChain } = makeDeps({ updateResult: [{ id: 'wh_1', integrationId: 'int_1' }] });

      const result = await service.replay('ws_1', 'wh_1');

      expect(result).toEqual({ status: 'accepted' });
      expect((updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ status: 'pending', retryCount: 0, error: null });
      expect(eventBus.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'integration.webhook.received', workspaceId: 'ws_1', entityId: 'int_1', payload: { webhookEventId: 'wh_1' } }),
      );
    });

    it('throws NotFoundError when no such webhook event exists in this workspace', async () => {
      const { service } = makeDeps({ updateResult: [], select: [[]] });

      await expect(service.replay('ws_1', 'wh_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('throws ConflictError when the event exists but is not dead-lettered', async () => {
      const { service, eventBus } = makeDeps({ updateResult: [], select: [[{ id: 'wh_1' }]] });

      await expect(service.replay('ws_1', 'wh_1')).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(eventBus.emit).not.toHaveBeenCalled();
    });
  });
});
