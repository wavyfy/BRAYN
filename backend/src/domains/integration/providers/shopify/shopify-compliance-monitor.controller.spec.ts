import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { ShopifyComplianceMonitorController } from './shopify-compliance-monitor.controller';
import type { ShopifyComplianceService } from './shopify-compliance.service';

function makeReply() {
  const reply = { header: vi.fn(), status: vi.fn() };
  reply.header.mockReturnValue(reply);
  reply.status.mockReturnValue(reply);
  return reply;
}

describe('ShopifyComplianceMonitorController', () => {
  it('200 with no open privacy issues', async () => {
    const service = {
      openIssues: vi.fn(async () => ({
        count: 0,
        quarantinedWebhooks: 0,
        overdue: 0,
        nearDeadline: 0,
        payloadExpired: 0,
        oldestReceivedAt: null,
        credentials: { reauthorizationRequired: 0, renewalFailed: 0, expired: 0, expiringSoon: 0 },
      })),
    } as unknown as ShopifyComplianceService;
    const reply = makeReply();
    const body = await new ShopifyComplianceMonitorController(service).status(
      reply as unknown as FastifyReply,
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(body).toEqual({
      healthy: true,
      openIssues: 0,
      quarantinedWebhooks: 0,
      overdue: 0,
      nearDeadline: 0,
      payloadExpired: 0,
      oldestOpenReceivedAt: null,
      credentials: { reauthorizationRequired: 0, renewalFailed: 0, expired: 0, expiringSoon: 0 },
    });
  });

  it('503 while any delivery is failed / an open exception / abandoned — count and timestamp only', async () => {
    const at = new Date('2026-11-26T10:00:00Z');
    const service = {
      openIssues: vi.fn(async () => ({
        count: 2,
        quarantinedWebhooks: 0,
        overdue: 1,
        nearDeadline: 1,
        payloadExpired: 0,
        oldestReceivedAt: at,
        credentials: { reauthorizationRequired: 0, renewalFailed: 0, expired: 0, expiringSoon: 0 },
      })),
    } as unknown as ShopifyComplianceService;
    const reply = makeReply();
    const body = await new ShopifyComplianceMonitorController(service).status(
      reply as unknown as FastifyReply,
    );
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(body).toEqual({
      healthy: false,
      openIssues: 2,
      quarantinedWebhooks: 0,
      overdue: 1,
      nearDeadline: 1,
      payloadExpired: 0,
      oldestOpenReceivedAt: at.toISOString(),
      credentials: { reauthorizationRequired: 0, renewalFailed: 0, expired: 0, expiringSoon: 0 },
    });
  });

  it('503 while a business webhook is quarantined (shop mismatch), even with no compliance issue', async () => {
    const service = {
      openIssues: vi.fn(async () => ({
        count: 0,
        quarantinedWebhooks: 1,
        overdue: 0,
        nearDeadline: 0,
        payloadExpired: 0,
        oldestReceivedAt: null,
        credentials: { reauthorizationRequired: 0, renewalFailed: 0, expired: 0, expiringSoon: 0 },
      })),
    } as unknown as ShopifyComplianceService;
    const reply = makeReply();
    const body = await new ShopifyComplianceMonitorController(service).status(
      reply as unknown as FastifyReply,
    );
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(body).toMatchObject({ healthy: false, openIssues: 0, quarantinedWebhooks: 1 });
  });

  const credentialCase = (credentials: Partial<Record<string, number>>) => ({
    openIssues: vi.fn(async () => ({
      count: 0,
      quarantinedWebhooks: 0,
      overdue: 0,
      nearDeadline: 0,
      payloadExpired: 0,
      oldestReceivedAt: null,
      credentials: { reauthorizationRequired: 0, renewalFailed: 0, expired: 0, expiringSoon: 0, ...credentials },
    })),
  }) as unknown as ShopifyComplianceService;

  it.each([{ reauthorizationRequired: 1 }, { expired: 1 }, { expiringSoon: 1 }])(
    '503 while a live Shopify connection is losing Admin API access (%o)',
    async (credentials) => {
      const reply = makeReply();
      const body = await new ShopifyComplianceMonitorController(credentialCase(credentials)).status(reply as unknown as FastifyReply);
      expect(reply.status).toHaveBeenCalledWith(503);
      expect(body).toMatchObject({ healthy: false, credentials });
    },
  );

  it('200 with only a transient renewal failure (retried by the next keep-alive; escalates via expiringSoon)', async () => {
    const reply = makeReply();
    const body = await new ShopifyComplianceMonitorController(credentialCase({ renewalFailed: 1 })).status(reply as unknown as FastifyReply);
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(body).toMatchObject({ healthy: true, credentials: { renewalFailed: 1 } });
  });
});
