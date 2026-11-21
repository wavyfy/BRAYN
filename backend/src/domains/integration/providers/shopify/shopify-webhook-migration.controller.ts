import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../../../../common/api/zod-validation.pipe';
import { Public } from '../../../../common/auth/public.decorator';
import { ShopifyWebhookMigrationGuard } from './shopify-webhook-migration.guard';
import { ShopifyWebhookMigrationService } from './shopify-webhook-migration.service';

/** An http(s) origin and nothing else — no path, query, fragment or credentials. */
const backendOrigin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && url.origin === value.replace(/\/+$/, '');
  }, 'Must be an http(s) origin (scheme, host and optional port only).');

const migrateSchema = z
  .object({
    /** The other BRAYN backend's origin the subscriptions currently point at (e.g. the old Render service). Never fetched. */
    fromBackendUrl: backendOrigin,
    /** Dry run unless explicitly true. */
    apply: z.boolean().default(false),
    /** Scope: exactly one of a single workspace or an explicit `allWorkspaces: true` — never all by omission. */
    workspaceId: z.string().uuid().optional(),
    allWorkspaces: z.literal(true).optional(),
  })
  .strict()
  .refine((body) => (body.workspaceId === undefined) !== (body.allWorkspaces === undefined), {
    message: 'Provide exactly one of workspaceId or allWorkspaces: true.',
    path: ['workspaceId'],
  });

/**
 * Operator-only, machine-authenticated with a dedicated migration secret (`@Public()` skips Clerk). Moves Shopify
 * per-shop webhook subscriptions to THIS backend — see ShopifyWebhookMigrationService.
 */
@Public()
@UseGuards(ShopifyWebhookMigrationGuard)
@Controller('internal/integrations/shopify/webhook-subscriptions')
export class ShopifyWebhookMigrationController {
  constructor(private readonly migrationService: ShopifyWebhookMigrationService) {}

  @Post('migrate')
  @HttpCode(HttpStatus.OK)
  async migrate(@Body(new ZodValidationPipe(migrateSchema)) body: z.infer<typeof migrateSchema>) {
    return this.migrationService.migrate(body);
  }
}
