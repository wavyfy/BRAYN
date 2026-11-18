import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { Env } from '../../../../config/env.schema';
import { ConflictError } from '../../../../common/errors/app-error';
import { IntegrationService } from '../../integration.service';

/** The topics the merchant creates in WooCommerce — exactly the ones `WooCommerceAdapter.parseWebhookEvent` processes. */
export const WOOCOMMERCE_SETUP_TOPICS = ['customer.created', 'customer.updated', 'product.created', 'product.updated', 'order.created', 'order.updated'] as const;

export interface WooCommerceWebhookSettings {
  webhookUrl: string;
  topics: readonly string[];
  secretConfigured: boolean;
}

/**
 * Manual WooCommerce webhook setup with read-only API keys (doc20 WooCommerce —
 * "Use the merchant's WooCommerce REST API and supported webhook mechanisms";
 * Stage 10 decision: manual setup, no webhook auto-registration). BRAYN generates
 * the signing secret and stores it in the integration's encrypted credentials as
 * `webhookSecret` — the field `WebhookIngestService` already verifies deliveries
 * against — and the merchant pastes it, with the delivery URL, into WooCommerce →
 * Settings → Advanced → Webhooks for each topic.
 *
 * Same pattern as `WebsiteTrackingKeyService`: settings never return the secret;
 * generating always mints a fresh one, so a regenerate is the rotation (the
 * previous secret stops verifying immediately — the merchant must update every
 * WooCommerce webhook).
 */
@Injectable()
export class WooCommerceWebhookSetupService {
  constructor(
    private readonly integrationService: IntegrationService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async getSettings(workspaceId: string): Promise<WooCommerceWebhookSettings> {
    const credentials = await this.integrationService.getCredentials(workspaceId, 'woocommerce');
    return { webhookUrl: this.webhookUrl(workspaceId), topics: WOOCOMMERCE_SETUP_TOPICS, secretConfigured: Boolean(credentials?.webhookSecret) };
  }

  async generateSecret(workspaceId: string): Promise<WooCommerceWebhookSettings & { webhookSecret: string }> {
    const credentials = await this.integrationService.getCredentials(workspaceId, 'woocommerce');
    // A secret is only useful next to working API keys (the import/sync credentials); never store it on its own.
    if (!credentials?.consumerKey) {
      throw new ConflictError('Connect WooCommerce with its API keys before setting up webhooks.');
    }

    const webhookSecret = randomBytes(32).toString('base64url');
    await this.integrationService.setCredentials(workspaceId, 'woocommerce', { ...credentials, webhookSecret });
    return { webhookUrl: this.webhookUrl(workspaceId), topics: WOOCOMMERCE_SETUP_TOPICS, secretConfigured: true, webhookSecret };
  }

  private webhookUrl(workspaceId: string): string {
    return `${this.config.get('BACKEND_URL', { infer: true })}/api/v1/workspaces/${workspaceId}/integrations/woocommerce/webhooks`;
  }
}
