import { Controller, Get } from '@nestjs/common';

/**
 * Liveness check only. Readiness checks for individual dependencies
 * (database, workers, ...) belong here once those dependencies actually
 * exist — see "26. BRAYN Deployment & Operations" (Health Checks).
 */
@Controller()
export class AppController {
  @Get('health')
  health() {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
