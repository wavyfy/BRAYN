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
      openIssues: vi.fn(async () => ({ count: 0, oldestReceivedAt: null })),
    } as unknown as ShopifyComplianceService;
    const reply = makeReply();
    const body = await new ShopifyComplianceMonitorController(service).status(
      reply as unknown as FastifyReply,
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(body).toEqual({ healthy: true, openIssues: 0, oldestOpenReceivedAt: null });
  });

  it('503 while any delivery is failed / an open exception / abandoned — count and timestamp only', async () => {
    const at = new Date('2026-11-26T10:00:00Z');
    const service = {
      openIssues: vi.fn(async () => ({ count: 2, oldestReceivedAt: at })),
    } as unknown as ShopifyComplianceService;
    const reply = makeReply();
    const body = await new ShopifyComplianceMonitorController(service).status(
      reply as unknown as FastifyReply,
    );
    expect(reply.status).toHaveBeenCalledWith(503);
    expect(body).toEqual({ healthy: false, openIssues: 2, oldestOpenReceivedAt: at.toISOString() });
  });
});
