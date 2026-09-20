import { describe, expect, it, vi } from 'vitest';
import { WebsiteTrackingKeyService } from './website-tracking-key.service';
import type { IntegrationService } from '../integration/integration.service';

describe('WebsiteTrackingKeyService', () => {
  it('generates a fresh key and stores it via IntegrationService.setCredentials', async () => {
    const integrationService = {
      setCredentials: vi.fn(async () => undefined),
    } as unknown as IntegrationService;
    const service = new WebsiteTrackingKeyService(integrationService);

    const result = await service.generate('ws_1');

    expect(result.writeKey).toEqual(expect.any(String));
    expect(result.writeKey.length).toBeGreaterThan(16);
    expect(integrationService.setCredentials).toHaveBeenCalledWith('ws_1', 'website_tracking', {
      writeKey: result.writeKey,
    });
  });

  it('generates a different key on each call (rotation)', async () => {
    const integrationService = { setCredentials: vi.fn(async () => undefined) } as unknown as IntegrationService;
    const service = new WebsiteTrackingKeyService(integrationService);

    const first = await service.generate('ws_1');
    const second = await service.generate('ws_1');

    expect(first.writeKey).not.toEqual(second.writeKey);
  });

  it('propagates NotFoundError when the workspace has no website_tracking integration to attach the key to', async () => {
    const boom = Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
    const integrationService = {
      setCredentials: vi.fn(async () => {
        throw boom;
      }),
    } as unknown as IntegrationService;
    const service = new WebsiteTrackingKeyService(integrationService);

    await expect(service.generate('ws_1')).rejects.toBe(boom);
  });
});
