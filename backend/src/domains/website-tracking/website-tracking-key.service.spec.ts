import { describe, expect, it, vi } from 'vitest';
import { WebsiteTrackingKeyService } from './website-tracking-key.service';
import type { IntegrationService } from '../integration/integration.service';
import type { DatabaseService } from '../../database/database.service';

const NO_DB = {} as DatabaseService;

/** A DB stub whose single `select … from … where` resolves to `rows`. */
function makeDb(rows: unknown[]) {
  const chain = { from: vi.fn(() => chain), where: vi.fn(async () => rows) };
  return { client: { select: vi.fn(() => chain) } } as unknown as DatabaseService;
}

function makeIntegrationService(existing: Record<string, string> | null = null) {
  return {
    getCredentials: vi.fn(async () => existing),
    setCredentials: vi.fn(async () => undefined),
  };
}

describe('WebsiteTrackingKeyService', () => {
  it('generates a fresh key and stores it via IntegrationService.setCredentials', async () => {
    const integrationService = makeIntegrationService();
    const service = new WebsiteTrackingKeyService(integrationService as unknown as IntegrationService, NO_DB);

    const result = await service.generate('ws_1');

    expect(result.writeKey).toEqual(expect.any(String));
    expect(result.writeKey.length).toBeGreaterThan(16);
    expect(integrationService.setCredentials).toHaveBeenCalledWith('ws_1', 'website_tracking', {
      writeKey: result.writeKey,
    });
  });

  it('generates a different key on each call (rotation)', async () => {
    const service = new WebsiteTrackingKeyService(makeIntegrationService() as unknown as IntegrationService, NO_DB);

    const first = await service.generate('ws_1');
    const second = await service.generate('ws_1');

    expect(first.writeKey).not.toEqual(second.writeKey);
  });

  it('rotating the write key keeps the identity secret and allowed origins', async () => {
    const integrationService = makeIntegrationService({ writeKey: 'old', identitySecret: 'secret', allowedOrigins: '["https://a.example"]' });
    const service = new WebsiteTrackingKeyService(integrationService as unknown as IntegrationService, NO_DB);

    const { writeKey } = await service.generate('ws_1');

    expect(integrationService.setCredentials).toHaveBeenCalledWith('ws_1', 'website_tracking', {
      writeKey,
      identitySecret: 'secret',
      allowedOrigins: '["https://a.example"]',
    });
  });

  it('generates an identity secret without touching the write key', async () => {
    const integrationService = makeIntegrationService({ writeKey: 'key_1' });
    const service = new WebsiteTrackingKeyService(integrationService as unknown as IntegrationService, NO_DB);

    const { identitySecret } = await service.generateIdentitySecret('ws_1');

    expect(identitySecret.length).toBeGreaterThanOrEqual(32);
    expect(integrationService.setCredentials).toHaveBeenCalledWith('ws_1', 'website_tracking', { writeKey: 'key_1', identitySecret });
  });

  it('stores allowed origins as a JSON array alongside the existing settings', async () => {
    const integrationService = makeIntegrationService({ writeKey: 'key_1' });
    const service = new WebsiteTrackingKeyService(integrationService as unknown as IntegrationService, NO_DB);

    const result = await service.setAllowedOrigins('ws_1', ['https://shop.example.com']);

    expect(result).toEqual({ allowedOrigins: ['https://shop.example.com'] });
    expect(integrationService.setCredentials).toHaveBeenCalledWith('ws_1', 'website_tracking', {
      writeKey: 'key_1',
      allowedOrigins: '["https://shop.example.com"]',
    });
  });

  describe('getSettings', () => {
    it('reports configuration flags, origins and the last event time — never the key or secret themselves', async () => {
      const integrationService = makeIntegrationService({ writeKey: 'key_1', identitySecret: 'secret_1', allowedOrigins: '["https://shop.example.com"]' });
      const service = new WebsiteTrackingKeyService(integrationService as unknown as IntegrationService, makeDb([{ lastEventAt: '2026-10-22 17:04:35.068+00' }]));

      const settings = await service.getSettings('ws_1');

      expect(settings).toEqual({
        allowedOrigins: ['https://shop.example.com'],
        writeKeyConfigured: true,
        identitySecretConfigured: true,
        lastEventAt: new Date('2026-10-22T17:04:35.068Z'),
      });
      expect(JSON.stringify(settings)).not.toContain('key_1');
      expect(JSON.stringify(settings)).not.toContain('secret_1');
    });

    it('returns an empty, unconfigured state when nothing is set yet and no events exist', async () => {
      const service = new WebsiteTrackingKeyService(makeIntegrationService(null) as unknown as IntegrationService, makeDb([{ lastEventAt: null }]));

      expect(await service.getSettings('ws_1')).toEqual({
        allowedOrigins: [],
        writeKeyConfigured: false,
        identitySecretConfigured: false,
        lastEventAt: null,
      });
    });
  });

  it('propagates NotFoundError when the workspace has no website_tracking integration to attach the key to', async () => {
    const boom = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    const integrationService = makeIntegrationService();
    integrationService.setCredentials.mockRejectedValueOnce(boom);
    const service = new WebsiteTrackingKeyService(integrationService as unknown as IntegrationService, NO_DB);

    await expect(service.generate('ws_1')).rejects.toBe(boom);
  });
});
