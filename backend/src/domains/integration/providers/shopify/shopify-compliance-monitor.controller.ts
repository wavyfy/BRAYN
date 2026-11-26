import { Controller, Get, HttpStatus, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../../../common/auth/public.decorator';
import { InternalMonitorGuard } from '../../../../common/auth/internal-monitor.guard';
import { ShopifyComplianceService } from './shopify-compliance.service';

/**
 * Privacy-exception alerting for an external uptime monitor (same read-only `BRAYN_MONITOR_SECRET` as the daily-run
 * monitor): 200 while no Shopify compliance delivery needs attention, 503 while any is `failed`, an open `exception`
 * (unknown shop / identity conflict) or an abandoned claim. Body: a count and a timestamp only — no shop or customer data.
 */
@Public()
@UseGuards(InternalMonitorGuard)
@Controller('internal/monitor/shopify-compliance')
export class ShopifyComplianceMonitorController {
  constructor(private readonly complianceService: ShopifyComplianceService) {}

  @Get()
  async status(@Res({ passthrough: true }) reply: FastifyReply) {
    const { count, oldestReceivedAt } = await this.complianceService.openIssues();
    reply.header('Cache-Control', 'no-store');
    reply.status(count === 0 ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      healthy: count === 0,
      openIssues: count,
      oldestOpenReceivedAt: oldestReceivedAt?.toISOString() ?? null,
    };
  }
}
