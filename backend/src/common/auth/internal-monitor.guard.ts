import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { StructuredLoggerService } from '../logging/structured-logger.service';
import { verifyBearerSecret } from './internal-cron.guard';

/**
 * Read-only machine auth for the external uptime monitor (`BRAYN_MONITOR_SECRET`). Separate from the cron secret so a
 * leaked monitor credential can read freshness but never start a run. Same fail-closed rules: unset → 503, wrong → 401.
 */
@Injectable()
export class InternalMonitorGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: StructuredLoggerService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    verifyBearerSecret(
      context,
      this.config.get('BRAYN_MONITOR_SECRET', { infer: true }),
      this.logger,
      'InternalMonitorGuard',
      'Rejected internal monitor request',
    );
    return true;
  }
}
