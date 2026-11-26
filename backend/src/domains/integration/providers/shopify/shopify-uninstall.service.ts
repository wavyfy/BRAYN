import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../../../database/database.service';
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

    // The payload is the Shop resource: its `id` is the stable shop id, so an uninstall reached under another domain
    // alias still finds the store; a row whose domain matches but whose id differs is another store and is left alone.
    let shopId: string | undefined;
    try {
      const id = (JSON.parse(rawBody) as { id?: unknown }).id;
      shopId = typeof id === 'number' || typeof id === 'string' ? String(id) : undefined;
    } catch {
      shopId = undefined;
    }
    const { holders, conflicts } = await this.integrationService.resolveShopHolders(shopDomain, shopId);

    let disconnected = 0;
    for (const integration of holders) {
      if (integration.status === 'disconnected') continue;
      await this.integrationService.disconnect(integration.workspaceId, 'shopify');
      disconnected++;
    }

    this.logger.event(holders.length === 0 || conflicts.length > 0 ? 'warn' : 'log', 'Shopify app/uninstalled processed', 'ShopifyUninstallService', {
      shopDomain,
      matched: holders.length,
      conflicting: conflicts.length,
      disconnected,
    });
    return { disconnected };
  }
}
