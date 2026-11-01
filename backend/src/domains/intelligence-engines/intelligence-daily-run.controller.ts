import { Controller, Get, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/auth/public.decorator';
import { InternalCronGuard } from '../../common/auth/internal-cron.guard';
import { IntelligenceDailyRunService } from './intelligence-daily-run.service';

/**
 * Internal endpoints for the external scheduler (Render Cron Job — Milestone
 * #5 D2). `@Public()` skips Clerk; InternalCronGuard is the only auth. Left
 * under the global IP-keyed public rate limit (a cron job calls a few times
 * a day), which also slows secret guessing.
 */
@Public()
@UseGuards(InternalCronGuard)
@Controller('internal/intelligence/daily-run')
export class IntelligenceDailyRunController {
  constructor(private readonly dailyRunService: IntelligenceDailyRunService) {}

  /** 202 when a run starts (work continues in the background); 200 with the existing run otherwise. */
  @Post()
  async start(@Res({ passthrough: true }) reply: FastifyReply) {
    const { run, started } = await this.dailyRunService.start();
    reply.status(started ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return { runId: run.id, status: run.status, started, startedAt: run.startedAt };
  }

  @Get('latest')
  async latest() {
    const run = await this.dailyRunService.getLatest();
    return {
      runId: run.id,
      status: run.status,
      customersProcessed: run.customersProcessed,
      healthRecalculated: run.healthRecalculated,
      healthSkipped: run.healthSkipped,
      customersFailed: run.customersFailed,
      error: run.error,
      startedAt: run.startedAt,
      heartbeatAt: run.heartbeatAt,
      completedAt: run.completedAt,
    };
  }
}
