import { describe, expect, it, vi } from 'vitest';
import { WebhookIngestService } from './webhook-ingest.service';
import type { DatabaseService } from '../../database/database.service';
import type { IntegrationService } from './integration.service';
import type { ProviderRegistry } from './provider-registry.service';
import type { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type { EventBus } from '../../common/events/event-bus.service';
import type { ProviderAdapter } from './provider-adapter.interface';

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
  reserve?: boolean;
  insertResult?: unknown;
  emit?: () => void;
} = {}) {
  const insertChain = makeChain([overrides.insertResult ?? { id: 'wh_1' }]);
  const updateChain = makeChain(undefined);
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

  const idempotency = {
    reserve: vi.fn(async () => overrides.reserve ?? true),
    complete: vi.fn(async () => undefined),
  } as unknown as IdempotencyService;

  const eventBus = { emit: overrides.emit ?? vi.fn() } as unknown as EventBus;

  const service = new WebhookIngestService(
    { client } as unknown as DatabaseService,
    integrationService,
    providerRegistry,
    idempotency,
    eventBus,
  );

  return { service, client, integrationService, providerRegistry, idempotency, eventBus, insertChain, updateChain };
}

describe('WebhookIngestService', () => {
  it('accepts a valid, new webhook delivery: verifies, dedupes, persists, emits', async () => {
    const { service, idempotency, eventBus, updateChain } = makeDeps();

    const result = await service.ingest('ws_1', 'shopify', '{}', { 'x-signature': 'sig' });

    expect(result).toEqual({ status: 'accepted', webhookEventId: 'wh_1' });
    expect(idempotency.reserve).toHaveBeenCalledWith('webhook:int_1:evt_1');
    expect(idempotency.complete).toHaveBeenCalledWith('webhook:int_1:evt_1');
    expect(eventBus.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'integration.webhook.received',
        workspaceId: 'ws_1',
        entityId: 'int_1',
        payload: { provider: 'shopify', eventType: 'orders/create', payload: { id: 1 } },
      }),
    );
    expect((updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ status: 'processed' });
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

  it('throws UnauthenticatedError when signature verification fails', async () => {
    const { service } = makeDeps({ adapter: makeAdapter({ verifyWebhookSignature: vi.fn(() => false) }) });

    await expect(service.ingest('ws_1', 'shopify', '{}', {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('returns ignored (and persists nothing) when the adapter does not recognize the payload', async () => {
    const { service, client } = makeDeps({ adapter: makeAdapter({ parseWebhookEvent: vi.fn(() => null) }) });

    const result = await service.ingest('ws_1', 'shopify', '{}', {});

    expect(result).toEqual({ status: 'ignored' });
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('returns duplicate (and persists nothing new) on a redelivered event', async () => {
    const { service, client } = makeDeps({ reserve: false });

    const result = await service.ingest('ws_1', 'shopify', '{}', {});

    expect(result).toEqual({ status: 'duplicate' });
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('marks the row failed and rethrows when downstream processing throws', async () => {
    const boom = new Error('listener exploded');
    const { service, updateChain } = makeDeps({
      emit: vi.fn(() => {
        throw boom;
      }),
    });

    await expect(service.ingest('ws_1', 'shopify', '{}', {})).rejects.toThrow(boom);
    expect((updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      status: 'failed',
      error: 'listener exploded',
    });
  });
});
