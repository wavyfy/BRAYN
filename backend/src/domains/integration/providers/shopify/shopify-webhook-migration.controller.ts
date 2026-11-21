import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../../common/api/zod-validation.pipe';
import { InternalCronGuard } from '../../../../common/auth/internal-cron.guard';
import { Public } from '../../../../common/auth/public.decorator';
import { ShopifyWebhookMigrationService } from './shopify-webhook-migration.service';

const migrateSchema = z
  .object({
    /** The other BRAYN backend's base URL the subscriptions currently point at (e.g. the old Render service). */
    fromBackendUrl: z
      .string()
      .url()
      .refine((value) => /^https?:\/\//.test(value), 'Must be an http(s) URL.'),
    /** Dry run unless explicitly true. */
    apply: z.boolean().default(false),
    workspaceId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Operator-only, machine-authenticated (same secret as the daily-run scheduler; `@Public()` skips Clerk). Moves Shopify
 * per-shop webhook subscriptions to THIS backend — see ShopifyWebhookMigrationService.
 */
@Public()
@UseGuards(InternalCronGuard)
@Controller('internal/integrations/shopify/webhook-subscriptions')
export class ShopifyWebhookMigrationController {
  constructor(private readonly migrationService: ShopifyWebhookMigrationService) {}

  @Post('migrate')
  @HttpCode(HttpStatus.OK)
  async migrate(@Body(new ZodValidationPipe(migrateSchema)) body: z.infer<typeof migrateSchema>) {
    return this.migrationService.migrate(body);
  }
}
