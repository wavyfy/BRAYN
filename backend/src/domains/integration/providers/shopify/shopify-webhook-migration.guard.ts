import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { verifyBearerSecret } from '../../../../common/auth/internal-cron.guard';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import type { Env } from '../../../../config/env.schema';

/**
 * Only authentication for the webhook-subscription migration endpoint: `Authorization: Bearer
 * <SHOPIFY_WEBHOOK_MIGRATION_SECRET>`. A dedicated secret (not the always-on cron secret held by GitHub Actions), unset
 * by default so the endpoint is disabled (503) outside an explicit migration window.
 */
@Injectable()
export class ShopifyWebhookMigrationGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: StructuredLoggerService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    verifyBearerSecret(
      context,
      this.config.get('SHOPIFY_WEBHOOK_MIGRATION_SECRET', { infer: true }),
      this.logger,
      'ShopifyWebhookMigrationGuard',
      'Rejected webhook migration request',
    );
    return true;
  }
}
