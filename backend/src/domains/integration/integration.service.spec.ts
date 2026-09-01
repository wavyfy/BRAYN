import { describe, expect, it, vi } from 'vitest';
import { IntegrationService } from './integration.service';
import type { DatabaseService } from '../../database/database.service';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';

const VALID_KEY = 'a'.repeat(64);

function makeConfig(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const env: Partial<Env> = { BRAYN_CREDENTIAL_ENCRYPTION_KEY: VALID_KEY, ...overrides };
  return { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
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
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig());

    const result = await service.listByWorkspace('ws_1');

    expect(result).toEqual(rows);
  });

  it('connect() inserts a new connected integration when none exists', async () => {
    const created = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
    const client = {
      select: makeSelectQueue([[]]),
      insert: vi.fn(() => makeChain([created])),
    };
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig());

    const result = await service.connect('ws_1', 'shopify');

    expect(result).toEqual(created);
    expect(client.insert).toHaveBeenCalled();
  });

  it('connect() throws ConflictError when the provider is already connected', async () => {
    const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected' };
    const client = { select: makeSelectQueue([[existing]]) };
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig());

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
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig());

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
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig());

    const result = await service.disconnect('ws_1', 'shopify');

    expect(result).toEqual(disconnected);
    expect(updateChain.set).toHaveBeenCalledWith({ status: 'disconnected' });
  });

  it('disconnect() throws NotFoundError when the workspace has no connection for that provider', async () => {
    const client = { select: makeSelectQueue([[]]) };
    const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig());

    await expect(service.disconnect('ws_1', 'shopify')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  describe('setCredentials() / getCredentials()', () => {
    it('encrypts on set and decrypts back the same payload on get', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: null };
      const updateChain = makeChain([existing]);
      const client = {
        select: makeSelectQueue([[existing]]),
        update: vi.fn(() => updateChain),
      };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig());

      await service.setCredentials('ws_1', 'shopify', { accessToken: 'shpat_secret' });

      const stored = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0].credentials as string;
      expect(stored).not.toContain('shpat_secret');

      const client2 = { select: makeSelectQueue([[{ ...existing, credentials: stored }]]) };
      const service2 = new IntegrationService({ client: client2 } as unknown as DatabaseService, makeConfig());

      await expect(service2.getCredentials('ws_1', 'shopify')).resolves.toEqual({ accessToken: 'shpat_secret' });
    });

    it('setCredentials() throws NotFoundError when the workspace has no connection for that provider', async () => {
      const client = { select: makeSelectQueue([[]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig());

      await expect(service.setCredentials('ws_1', 'shopify', { accessToken: 'x' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('getCredentials() returns null when no credentials have been stored yet', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: null };
      const client = { select: makeSelectQueue([[existing]]) };
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig());

      await expect(service.getCredentials('ws_1', 'shopify')).resolves.toBeNull();
    });

    it('setCredentials() fails closed when the encryption key is missing', async () => {
      const existing = { id: 'int_1', workspaceId: 'ws_1', provider: 'shopify', status: 'connected', credentials: null };
      const client = { select: makeSelectQueue([[existing]]) };
      const service = new IntegrationService(
        { client } as unknown as DatabaseService,
        makeConfig({ BRAYN_CREDENTIAL_ENCRYPTION_KEY: undefined }),
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
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig());

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
      const service = new IntegrationService({ client } as unknown as DatabaseService, makeConfig());

      await service.connect('ws_1', 'shopify');

      const returningArg = (insertChain.returning as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(returningArg).not.toHaveProperty('credentials');
    });
  });
});
