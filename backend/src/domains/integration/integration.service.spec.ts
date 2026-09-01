import { describe, expect, it, vi } from 'vitest';
import { IntegrationService } from './integration.service';
import type { DatabaseService } from '../../database/database.service';

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
    const service = new IntegrationService({ client } as unknown as DatabaseService);

    const result = await service.listByWorkspace('ws_1');

    expect(result).toEqual(rows);
  });

  it('connect() inserts a new connected integration when none exists', async () => {
    const created = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
    const client = {
      select: makeSelectQueue([[]]),
      insert: vi.fn(() => makeChain([created])),
    };
    const service = new IntegrationService({ client } as unknown as DatabaseService);

    const result = await service.connect('ws_1', 'shopify');

    expect(result).toEqual(created);
    expect(client.insert).toHaveBeenCalled();
  });

  it('connect() throws ConflictError when the provider is already connected', async () => {
    const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
    const client = { select: makeSelectQueue([[existing]]) };
    const service = new IntegrationService({ client } as unknown as DatabaseService);

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
    const service = new IntegrationService({ client } as unknown as DatabaseService);

    const result = await service.connect('ws_1', 'shopify');

    expect(result).toEqual(reconnected);
    expect(updateChain.set).toHaveBeenCalledWith({ status: 'connected' });
  });

  it('disconnect() marks a connected integration as disconnected', async () => {
    const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
    const disconnected = { ...existing, status: 'disconnected' };
    const updateChain = makeChain([disconnected]);
    const client = {
      select: makeSelectQueue([[existing]]),
      update: vi.fn(() => updateChain),
    };
    const service = new IntegrationService({ client } as unknown as DatabaseService);

    const result = await service.disconnect('ws_1', 'shopify');

    expect(result).toEqual(disconnected);
    expect(updateChain.set).toHaveBeenCalledWith({ status: 'disconnected' });
  });

  it('disconnect() throws NotFoundError when the workspace has no connection for that provider', async () => {
    const client = { select: makeSelectQueue([[]]) };
    const service = new IntegrationService({ client } as unknown as DatabaseService);

    await expect(service.disconnect('ws_1', 'shopify')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
