import { Controller, Get, HttpStatus, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/auth/public.decorator';
import { InternalMonitorGuard } from '../../common/auth/internal-monitor.guard';
import { IntelligenceDailyRunService } from './intelligence-daily-run.service';

/**
 * Missed-run detection for an external uptime monitor (not GitHub, so it doesn't share the scheduler it watches):
 * 200 while the daily run is fresh, 503 once a UTC day passes its deadline without a run that started that day and
 * succeeded. Monitors alert on any non-2xx, so a broken backend alerts too. `@Public()` skips Clerk; the read-only
 * monitor secret is the only auth. Body: timestamps and statuses only.
 */
@Public()
@UseGuards(InternalMonitorGuard)
@Controller('internal/monitor/daily-run')
export class IntelligenceDailyRunMonitorController {
  constructor(private readonly dailyRunService: IntelligenceDailyRunService) {}

  @Get()
  async freshness(@Res({ passthrough: true }) reply: FastifyReply) {
    const freshness = await this.dailyRunService.getFreshness();
    // Never cached by a proxy or the monitor: every poll must reflect the database.
    reply.header('Cache-Control', 'no-store');
    reply.status(freshness.healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return freshness;
  }
}
