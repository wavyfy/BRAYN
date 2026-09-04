import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../../../../database/database.service';
import { customerDataRequests } from '../../../../database/schema/customer-data-requests';
import { ProviderError, UnauthenticatedError, ValidationError } from '../../../../common/errors/app-error';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import { IntegrationService } from '../../integration.service';
import { verifyShopifyHmac } from './shopify.adapter';
import type { Env } from '../../../../config/env.schema';

export const SHOPIFY_COMPLIANCE_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'] as const;
export type ShopifyComplianceTopic = (typeof SHOPIFY_COMPLIANCE_TOPICS)[number];

interface ShopifyComplianceCustomer {
  id?: number | string;
  email?: string;
}

interface ShopifyDataRequestPayload {
  shop_domain?: string;
  customer?: ShopifyComplianceCustomer;
  orders_requested?: number[];
}

interface ShopifyCustomersRedactPayload {
  shop_domain?: string;
  customer?: ShopifyComplianceCustomer;
}

interface ShopifyShopRedactPayload {
  shop_domain?: string;
}

/**
 * Shopify's three mandatory, app-level compliance webhooks (Shopify
 * Protected Customer Data — `customers/data_request`, `customers/redact`,
 * `shop/redact`). Deliberately separate from `WebhookIngestService`'s
 * per-workspace pipeline (doc 21) — that pipeline is keyed by a
 * `:workspaceId` in the URL and a per-integration `webhookSecret`, which
 * these webhooks don't carry: Shopify calls one fixed URL for every shop
 * the app is installed on, signed with the app's own client secret
 * (`SHOPIFY_APP_CLIENT_SECRET`), with only `shop_domain` in the payload to
 * resolve which workspace/integration it's about (see
 * `IntegrationService.findByShopDomain`). Forcing that through the
 * existing pipeline's `WebhookResourceEvent` shape and per-integration
 * secret lookup would distort it rather than reuse it — hence a small,
 * parallel handler instead of extending it.
 *
 * Never routes a raw request/webhook body, email, phone, or secret
 * through `StructuredLoggerService` — every `logger.event` call below
 * carries only `shopDomain`/`topic`/booleans. The one place a customer
 * identifier (external id, email) is persisted is `customer_data_requests`
 * — a deliberate, minimal business record for manual handling, not a log.
 */
@Injectable()
export class ShopifyComplianceService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly database: DatabaseService,
    private readonly integrationService: IntegrationService,
    private readonly logger: StructuredLoggerService,
  ) {}

  /**
   * Verifies the app-level HMAC, then dispatches by topic. Always
   * returns normally (never throws) once the signature is valid — even
   * when the shop can't be resolved to a workspace/integration, since
   * Shopify requires a 2xx acknowledgement regardless (a shop that
   * uninstalled and was already erased, or one BRAYN never actually
   * connected, still gets an ack, just does nothing).
   */
  async handle(topic: string, rawBody: string, headers: Record<string, string>): Promise<void> {
    const clientSecret = this.config.get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    if (!clientSecret) {
      throw new ProviderError('Shopify compliance webhooks are not configured.');
    }
    if (!verifyShopifyHmac(rawBody, headers, clientSecret)) {
      throw new UnauthenticatedError('Webhook signature verification failed.');
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new ValidationError('Malformed compliance webhook payload.');
    }

    switch (topic as ShopifyComplianceTopic) {
      case 'customers/data_request':
        await this.handleDataRequest(body as ShopifyDataRequestPayload);
        return;
      case 'customers/redact':
        await this.handleCustomersRedact(body as ShopifyCustomersRedactPayload);
        return;
      case 'shop/redact':
        await this.handleShopRedact(body as ShopifyShopRedactPayload);
        return;
      default:
        this.logger.event('warn', 'Unrecognized Shopify compliance topic', 'ShopifyComplianceService', { topic });
    }
  }

  /**
   * Persists the request for manual handling (Shopify Protected Customer
   * Data — the merchant must be able to answer a customer's data-access
   * request; not an automated export). Carries the customer identifiers
   * Shopify's payload provides because a human needs them to act — this
   * is the legitimate record, not a log line.
   */
  private async handleDataRequest(body: ShopifyDataRequestPayload): Promise<void> {
    const shopDomain = body.shop_domain;
    if (!shopDomain) {
      throw new ValidationError('Missing shop_domain in compliance webhook payload.');
    }
    const integration = await this.integrationService.findByShopDomain(shopDomain);

    await this.database.client.insert(customerDataRequests).values({
      workspaceId: integration?.workspaceId ?? null,
      integrationId: integration?.id ?? null,
      provider: 'shopify',
      shopDomain,
      shopifyCustomerId: body.customer?.id !== undefined ? String(body.customer.id) : '',
      customerEmail: body.customer?.email ?? null,
      ordersRequested: body.orders_requested ?? null,
    });

    this.logger.event('log', 'Shopify customers/data_request recorded for manual handling', 'ShopifyComplianceService', {
      shopDomain,
      resolved: Boolean(integration),
    });
  }

  /** Erases one customer's data, if the shop and that customer are both known to BRAYN. */
  private async handleCustomersRedact(body: ShopifyCustomersRedactPayload): Promise<void> {
    const shopDomain = body.shop_domain;
    if (!shopDomain) {
      throw new ValidationError('Missing shop_domain in compliance webhook payload.');
    }
    const externalId = body.customer?.id !== undefined ? String(body.customer.id) : undefined;

    const integration = await this.integrationService.findByShopDomain(shopDomain);
    if (!integration || !externalId) {
      this.logger.event('log', 'Shopify customers/redact — nothing to erase (shop or customer not recognized)', 'ShopifyComplianceService', {
        shopDomain,
        resolved: Boolean(integration),
      });
      return;
    }

    const result = await this.integrationService.purgeCommerceCustomer(integration.workspaceId, integration.id, externalId);

    this.logger.event('log', 'Shopify customers/redact processed', 'ShopifyComplianceService', {
      shopDomain,
      found: result.found,
      canonicalCustomerRemoved: result.canonicalCustomerRemoved,
    });
  }

  /** Erases everything the resolved integration owns, if the shop is known to BRAYN. */
  private async handleShopRedact(body: ShopifyShopRedactPayload): Promise<void> {
    const shopDomain = body.shop_domain;
    if (!shopDomain) {
      throw new ValidationError('Missing shop_domain in compliance webhook payload.');
    }

    const integration = await this.integrationService.findByShopDomain(shopDomain);
    if (!integration) {
      this.logger.event('log', 'Shopify shop/redact — shop not recognized, nothing to erase', 'ShopifyComplianceService', { shopDomain });
      return;
    }

    const result = await this.integrationService.eraseIntegrationForShopRedact(integration.id);

    this.logger.event('log', 'Shopify shop/redact processed', 'ShopifyComplianceService', { shopDomain, found: result.found });
  }
}
