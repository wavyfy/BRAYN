import { describe, expect, it, vi } from 'vitest';
import { WebsiteTrackingKeyService } from './website-tracking-key.service';
import type { IntegrationService } from '../integration/integration.service';

function makeIntegrationService(existing: Record<string, string> | null = null) {
  return {
    getCredentials: vi.fn(async () => existing),
    setCredentials: vi.fn(async () => undefined),
  };
}

describe('WebsiteTrackingKeyService', () => {
  it('generates a fresh key and stores it via IntegrationService.setCredentials', async () => {
    const integrationService = makeIntegrationService();
    const service = new WebsiteTrackingKeyService(integrationService as unknown as IntegrationService);

    const result = await service.generate('ws_1');

    expect(result.writeKey).toEqual(expect.any(String));
    expect(result.writeKey.length).toBeGreaterThan(16);
    expect(integrationService.setCredentials).toHaveBeenCalledWith('ws_1', 'website_tracking', {
      writeKey: result.writeKey,
    });
  });

  it('generates a different key on each call (rotation)', async () => {
    const service = new WebsiteTrackingKeyService(makeIntegrationService() as unknown as IntegrationService);

    const first = await service.generate('ws_1');
    const second = await service.generate('ws_1');

    expect(first.writeKey).not.toEqual(second.writeKey);
  });

  it('rotating the write key keeps the identity secret and allowed origins', async () => {
    const integrationService = makeIntegrationService({ writeKey: 'old', identitySecret: 'secret', allowedOrigins: '["https://a.example"]' });
    const service = new WebsiteTrackingKeyService(integrationService as unknown as IntegrationService);

    const { writeKey } = await service.generate('ws_1');

    expect(integrationService.setCredentials).toHaveBeenCalledWith('ws_1', 'website_tracking', {
      writeKey,
      identitySecret: 'secret',
      allowedOrigins: '["https://a.example"]',
    });
  });

  it('generates an identity secret without touching the write key', async () => {
    const integrationService = makeIntegrationService({ writeKey: 'key_1' });
    const service = new WebsiteTrackingKeyService(integrationService as unknown as IntegrationService);

    const { identitySecret } = await service.generateIdentitySecret('ws_1');

    expect(identitySecret.length).toBeGreaterThanOrEqual(32);
    expect(integrationService.setCredentials).toHaveBeenCalledWith('ws_1', 'website_tracking', { writeKey: 'key_1', identitySecret });
  });

  it('stores allowed origins as a JSON array alongside the existing settings', async () => {
    const integrationService = makeIntegrationService({ writeKey: 'key_1' });
    const service = new WebsiteTrackingKeyService(integrationService as unknown as IntegrationService);

    const result = await service.setAllowedOrigins('ws_1', ['https://shop.example.com']);

    expect(result).toEqual({ allowedOrigins: ['https://shop.example.com'] });
    expect(integrationService.setCredentials).toHaveBeenCalledWith('ws_1', 'website_tracking', {
      writeKey: 'key_1',
      allowedOrigins: '["https://shop.example.com"]',
    });
  });

  it('propagates NotFoundError when the workspace has no website_tracking integration to attach the key to', async () => {
    const boom = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    const integrationService = makeIntegrationService();
    integrationService.setCredentials.mockRejectedValueOnce(boom);
    const service = new WebsiteTrackingKeyService(integrationService as unknown as IntegrationService);

    await expect(service.generate('ws_1')).rejects.toBe(boom);
  });
});
