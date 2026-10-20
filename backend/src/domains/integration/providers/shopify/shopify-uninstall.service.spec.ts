import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { ShopifyUninstallService } from './shopify-uninstall.service';
import type { DatabaseService } from '../../../../database/database.service';
import type { IntegrationService } from '../../integration.service';
import type { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import type { Env } from '../../../../config/env.schema';

const CLIENT_SECRET = 'client_secret';
const SHOP = 'acme.myshopify.com';
const BODY = JSON.stringify({ id: 1, myshopify_domain: SHOP });

function signedHeaders(overrides: Record<string, string> = {}, body = BODY, secret = CLIENT_SECRET): Record<string, string> {
  return {
    'x-shopify-topic': 'app/uninstalled',
    'x-shopify-shop-domain': SHOP,
    'x-shopify-hmac-sha256': createHmac('sha256', secret).update(body, 'utf8').digest('base64'),
    ...overrides,
  };
}

function makeService(options: { rows?: { workspaceId: string; status: string }[]; clientSecret?: string | undefined } = {}) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(async () => options.rows ?? [{ workspaceId: 'ws_1', status: 'connected' }]);
  const client = { select: vi.fn(() => chain) };
  const env: Partial<Env> = { SHOPIFY_APP_CLIENT_SECRET: 'clientSecret' in options ? options.clientSecret : CLIENT_SECRET };
  const config = { get: (key: keyof Env) => env[key] } as unknown as ConfigService<Env, true>;
  const integrationService = { disconnect: vi.fn(async () => ({})) } as unknown as IntegrationService;
  const logger = { event: vi.fn() } as unknown as StructuredLoggerService;

  return {
    service: new ShopifyUninstallService(config, { client } as unknown as DatabaseService, integrationService, logger),
    client,
    integrationService,
  };
}

describe('ShopifyUninstallService', () => {
  it('disconnects the shop’s integration (credentials cleared, data kept — disconnect() never deletes data)', async () => {
    const { service, integrationService } = makeService();

    await expect(service.handle(BODY, signedHeaders())).resolves.toEqual({ disconnected: 1 });
    expect(integrationService.disconnect).toHaveBeenCalledWith('ws_1', 'shopify');
  });

  it('disconnects every workspace connected to that shop (one app token per shop, now revoked for all)', async () => {
    const { service, integrationService } = makeService({
      rows: [
        { workspaceId: 'ws_1', status: 'connected' },
        { workspaceId: 'ws_2', status: 'error' },
      ],
    });

    await expect(service.handle(BODY, signedHeaders())).resolves.toEqual({ disconnected: 2 });
    expect(integrationService.disconnect).toHaveBeenCalledWith('ws_2', 'shopify');
  });

  it('is harmless when repeated: an already-disconnected integration is a successful no-op', async () => {
    const { service, integrationService } = makeService({ rows: [{ workspaceId: 'ws_1', status: 'disconnected' }] });

    await expect(service.handle(BODY, signedHeaders())).resolves.toEqual({ disconnected: 0 });
    expect(integrationService.disconnect).not.toHaveBeenCalled();
  });

  it('is a successful no-op for a shop BRAYN does not know', async () => {
    const { service } = makeService({ rows: [] });

    await expect(service.handle(BODY, signedHeaders())).resolves.toEqual({ disconnected: 0 });
  });

  it('rejects a delivery not signed with the app client secret, touching nothing', async () => {
    const { service, client, integrationService } = makeService();

    await expect(service.handle(BODY, signedHeaders({}, BODY, 'attacker_secret'))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(client.select).not.toHaveBeenCalled();
    expect(integrationService.disconnect).not.toHaveBeenCalled();
  });

  it('rejects any topic other than app/uninstalled', async () => {
    const { service, integrationService } = makeService();

    await expect(service.handle(BODY, signedHeaders({ 'x-shopify-topic': 'orders/create' }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(integrationService.disconnect).not.toHaveBeenCalled();
  });

  it('rejects a missing or malformed shop domain header', async () => {
    const { service } = makeService();

    await expect(service.handle(BODY, signedHeaders({ 'x-shopify-shop-domain': 'evil.example.com' }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('fails closed when the app client secret is not configured', async () => {
    const { service } = makeService({ clientSecret: undefined });

    await expect(service.handle(BODY, signedHeaders())).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  });
});
