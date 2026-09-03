import { Controller, Get } from '@nestjs/common';
import { Public } from './common/auth/public.decorator';
import { DatabaseService } from './database/database.service';

type DependencyStatus = 'ok' | 'error' | 'not_configured';

/**
 * Liveness endpoint that also reports dependency status. Always returns
 * 200 — this is liveness (is the process alive), not readiness; Render's
 * health check restarting the process because a dependency briefly
 * hiccupped would make things worse, not better. `checks` is what makes
 * the status actionable — see "26. BRAYN Deployment & Operations"
 * (Health Checks).
 */
@Controller()
export class AppController {
  constructor(private readonly database: DatabaseService) {}

  @Get('health')
  @Public()
  async health() {
    const database = await this.checkDatabase();

    return {
      status: database === 'error' ? 'degraded' : 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      checks: { database },
    };
  }

  private async checkDatabase(): Promise<DependencyStatus> {
    if (!this.database.isConfigured()) {
      return 'not_configured';
    }

    try {
      await this.database.ping();
      return 'ok';
    } catch {
      return 'error';
    }
  }
}
