import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service';
import { integrations } from '../../../../database/schema/integrations';
import { ProviderError, UnauthenticatedError, ValidationError } from '../../../../common/errors/app-error';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import { IntegrationService } from '../../integration.service';
import { SHOPIFY_APP_UNINSTALLED_TOPIC, SHOPIFY_DOMAIN_PATTERN, verifyShopifyHmac } from './shopify.adapter';
import type { Env } from '../../../../config/env.schema';

export interface ShopifyUninstallResult {
  disconnected: number;
}

/**
 * Handles Shopify's `app/uninstalled` webhook: the merchant removed the
 * app, so Shopify has revoked BRAYN's access token for that shop. Every
 * BRAYN integration connected to that shop is disconnected via the normal
 * `IntegrationService.disconnect()` — credentials cleared, status
 * `disconnected` (which WebhookIngestService and sync already refuse), and
 * all historical merchant data kept (deletion is shop/redact's job, which
 * Shopify sends separately after its own retention window).
 *
 * App-level like ShopifyComplianceService (one route for every shop, signed
 * with SHOPIFY_APP_CLIENT_SECRET, resolved by shop domain) rather than the
 * per-workspace webhook pipeline: that pipeline rejects deliveries for a
 * disconnected integration, so a retried uninstall would loop on a 409.
 * Synchronous and idempotent — an already-disconnected or unknown shop is a
 * successful no-op, so a redelivery is harmless; a failure throws (non-2xx)
 * so Shopify retries.
 */
@Injectable()
export class ShopifyUninstallService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly database: DatabaseService,
    private readonly integrationService: IntegrationService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async handle(rawBody: string, headers: Record<string, string>): Promise<ShopifyUninstallResult> {
    const clientSecret = this.config.get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    if (!clientSecret) {
      throw new ProviderError('Shopify app webhooks are not configured.');
    }
    if (!verifyShopifyHmac(rawBody, headers, clientSecret)) {
      throw new UnauthenticatedError('Webhook signature verification failed.');
    }
    if (headers['x-shopify-topic'] !== SHOPIFY_APP_UNINSTALLED_TOPIC) {
      throw new ValidationError('This endpoint only accepts app/uninstalled.');
    }

    const shopDomain = headers['x-shopify-shop-domain'];
    if (!shopDomain || !SHOPIFY_DOMAIN_PATTERN.test(shopDomain)) {
      throw new ValidationError('Missing or invalid X-Shopify-Shop-Domain.');
    }

    const connected = await this.database.client
      .select({ workspaceId: integrations.workspaceId, status: integrations.status })
      .from(integrations)
      .where(and(eq(integrations.provider, 'shopify'), eq(integrations.shopDomain, shopDomain)));

    let disconnected = 0;
    for (const integration of connected) {
      if (integration.status === 'disconnected') continue;
      await this.integrationService.disconnect(integration.workspaceId, 'shopify');
      disconnected++;
    }

    this.logger.event('log', 'Shopify app/uninstalled processed', 'ShopifyUninstallService', {
      shopDomain,
      matched: connected.length,
      disconnected,
    });
    return { disconnected };
  }
}
