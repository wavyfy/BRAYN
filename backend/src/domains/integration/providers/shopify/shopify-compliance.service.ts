import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DatabaseService } from '../../../../database/database.service';
import { customerDataRequests } from '../../../../database/schema/customer-data-requests';
import { shopifyComplianceWebhooks } from '../../../../database/schema/shopify-compliance-webhooks';
import { ConflictError, ProviderError, UnauthenticatedError, ValidationError } from '../../../../common/errors/app-error';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import { IntegrationService } from '../../integration.service';
import { verifyShopifyHmac } from './shopify.adapter';
import type { Env } from '../../../../config/env.schema';

export const SHOPIFY_COMPLIANCE_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'] as const;
export type ShopifyComplianceTopic = (typeof SHOPIFY_COMPLIANCE_TOPICS)[number];

/** A claim older than this is treated as abandoned (crashed or timed-out attempt) and may be retaken by a redelivery. */
const STALE_CLAIM_INTERVAL = sql`interval '5 minutes'`;

interface ShopifyComplianceCustomer {
  id?: number | string;
  email?: string;
}

interface ShopifyCompliancePayload {
  shop_id?: number | string;
  shop_domain?: string;
}

interface ShopifyDataRequestPayload extends ShopifyCompliancePayload {
  customer?: ShopifyComplianceCustomer;
  orders_requested?: number[];
}

interface ShopifyCustomersRedactPayload extends ShopifyCompliancePayload {
  customer?: ShopifyComplianceCustomer;
  orders_to_redact?: Array<number | string>;
}

type Outcome = { outcome: 'erased' | 'nothing_found' | 'recorded' | 'unknown_shop'; matchedIntegrations: number };

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
 * `IntegrationService.findAllByShopDomain`). Forcing that through the
 * existing pipeline's `WebhookResourceEvent` shape and per-integration
 * secret lookup would distort it rather than reuse it — hence a small,
 * parallel handler instead of extending it.
 *
 * Retry contract (Shopify: 2xx = received; anything else is retried 8 times over 4 hours; dedupe by
 * `X-Shopify-Webhook-Id`): every verified delivery is claimed in `shopify_compliance_webhooks` first. 2xx is returned
 * only once the work is durably done (`processed`), or for a redelivery of an already-processed one. A failure is
 * recorded (`failed`, error category only) and rethrown, so Shopify redelivers and the next attempt reprocesses it;
 * erasure is idempotent, and a data request's records commit in the same transaction as `processed`, so a retry never
 * duplicates them. A redelivery that arrives while an attempt is still running gets 409 and is retried later.
 *
 * Never routes a raw request/webhook body, email, phone, or secret
 * through `StructuredLoggerService` — every `logger.event` call below
 * carries only `shopDomain`/`topic`/counts. The one place a customer
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
   * Verifies the app-level HMAC, claims the delivery, then dispatches by topic. A shop that can't be resolved to any
   * integration (already erased, never connected, or an alias BRAYN doesn't know) is still acknowledged, as Shopify
   * requires, and recorded as `unknown_shop` for review.
   */
  async handle(topic: string, rawBody: string, headers: Record<string, string>): Promise<void> {
    const clientSecret = this.config.get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    if (!clientSecret) {
      throw new ProviderError('Shopify compliance webhooks are not configured.');
    }
    if (!verifyShopifyHmac(rawBody, headers, clientSecret)) {
      throw new UnauthenticatedError('Webhook signature verification failed.');
    }

    let body: ShopifyCompliancePayload;
    try {
      body = JSON.parse(rawBody) as ShopifyCompliancePayload;
    } catch {
      throw new ValidationError('Malformed compliance webhook payload.');
    }

    if (!(SHOPIFY_COMPLIANCE_TOPICS as readonly string[]).includes(topic)) {
      this.logger.event('warn', 'Unrecognized Shopify compliance topic', 'ShopifyComplianceService', { topic });
      return;
    }
    const shopDomain = body?.shop_domain;
    if (!shopDomain) {
      throw new ValidationError('Missing shop_domain in compliance webhook payload.');
    }

    // Shopify's per-delivery dedupe key. If it is ever absent the delivery is still audited, but under a unique key:
    // deduplicating by body could skip a genuine repeat request (e.g. the same customer redacted again after re-import).
    const webhookId = headers['x-shopify-webhook-id'] || `missing:${randomUUID()}`;
    const claim = await this.claim(webhookId, topic, shopDomain, body.shop_id);
    if (claim === 'done') {
      this.logger.event('log', 'Shopify compliance redelivery of a processed webhook — acknowledged', 'ShopifyComplianceService', { topic, shopDomain });
      return;
    }
    if (claim === 'busy') {
      throw new ConflictError('This compliance delivery is already being processed.');
    }

    try {
      switch (topic as ShopifyComplianceTopic) {
        case 'customers/data_request':
          await this.handleDataRequest(webhookId, body as ShopifyDataRequestPayload, shopDomain);
          return;
        case 'customers/redact':
          await this.complete(this.database.client, webhookId, await this.handleCustomersRedact(body as ShopifyCustomersRedactPayload, shopDomain));
          return;
        case 'shop/redact':
          await this.complete(this.database.client, webhookId, await this.handleShopRedact(shopDomain));
          return;
      }
    } catch (error) {
      await this.fail(webhookId, error);
      throw error;
    }
  }

  /** `claimed` = this attempt owns the delivery; `done` = already processed; `busy` = another attempt is running. */
  private async claim(
    webhookId: string,
    topic: string,
    shopDomain: string,
    shopId: number | string | undefined,
  ): Promise<'claimed' | 'done' | 'busy'> {
    const t = shopifyComplianceWebhooks;
    const [claimed] = await this.database.client
      .insert(t)
      .values({ webhookId, topic, shopDomain, shopId: shopId === undefined ? null : String(shopId), status: 'processing' })
      .onConflictDoUpdate({
        target: t.webhookId,
        set: { status: 'processing', attempts: sql`${t.attempts} + 1`, claimedAt: sql`now()`, error: null },
        setWhere: sql`${t.status} = 'failed' or (${t.status} = 'processing' and ${t.claimedAt} < now() - ${STALE_CLAIM_INTERVAL})`,
      })
      .returning({ id: t.id });
    if (claimed) {
      return 'claimed';
    }
    const [existing] = await this.database.client.select({ status: t.status }).from(t).where(eq(t.webhookId, webhookId)).limit(1);
    return existing?.status === 'processed' ? 'done' : 'busy';
  }

  private async complete(client: NodePgDatabase, webhookId: string, result: Outcome): Promise<void> {
    await client
      .update(shopifyComplianceWebhooks)
      .set({ status: 'processed', outcome: result.outcome, matchedIntegrations: result.matchedIntegrations, error: null, processedAt: sql`now()` })
      .where(eq(shopifyComplianceWebhooks.webhookId, webhookId));
  }

  /** Best effort: recording the failure must never mask the original error that makes Shopify redeliver. */
  private async fail(webhookId: string, error: unknown): Promise<void> {
    const category = (error as { code?: unknown })?.code ?? (error instanceof Error ? error.name : 'unknown');
    try {
      await this.database.client
        .update(shopifyComplianceWebhooks)
        .set({ status: 'failed', error: String(category).slice(0, 64) })
        .where(eq(shopifyComplianceWebhooks.webhookId, webhookId));
    } catch {
      this.logger.event('error', 'Could not record a failed Shopify compliance webhook', 'ShopifyComplianceService', { webhookId });
    }
  }

  /**
   * Persists the request for manual handling (Shopify Protected Customer
   * Data — the merchant must be able to answer a customer's data-access
   * request; not an automated export). Carries the customer identifiers
   * Shopify's payload provides because a human needs them to act — this
   * is the legitimate record, not a log line. One record per workspace that
   * holds (or held) this store's data, so each owner sees the request; an
   * unknown shop is still recorded once, unassigned. Committed together
   * with the `processed` mark, so a redelivery never duplicates records.
   */
  private async handleDataRequest(webhookId: string, body: ShopifyDataRequestPayload, shopDomain: string): Promise<void> {
    const matches = await this.integrationService.findAllByShopDomain(shopDomain);
    const owners = matches.length > 0 ? matches : [null];

    await this.database.transaction(async (tx) => {
      await tx.insert(customerDataRequests).values(
        owners.map((integration) => ({
          workspaceId: integration?.workspaceId ?? null,
          integrationId: integration?.id ?? null,
          provider: 'shopify' as const,
          shopDomain,
          shopifyCustomerId: body.customer?.id !== undefined ? String(body.customer.id) : '',
          customerEmail: body.customer?.email ?? null,
          ordersRequested: body.orders_requested ?? null,
        })),
      );
      await this.complete(tx, webhookId, { outcome: matches.length > 0 ? 'recorded' : 'unknown_shop', matchedIntegrations: matches.length });
    });

    this.logger.event('log', 'Shopify customers/data_request recorded for manual handling', 'ShopifyComplianceService', {
      shopDomain,
      resolved: matches.length > 0,
      matchedIntegrations: matches.length,
    });
  }

  /** Erases the customer and the orders Shopify lists, in every workspace that holds the store's data. */
  private async handleCustomersRedact(body: ShopifyCustomersRedactPayload, shopDomain: string): Promise<Outcome> {
    const externalId = body.customer?.id !== undefined ? String(body.customer.id) : undefined;
    const orderIds = Array.isArray(body.orders_to_redact) ? body.orders_to_redact.map(String) : [];

    const matches = await this.integrationService.findAllByShopDomain(shopDomain);
    if (matches.length === 0 || (externalId === undefined && orderIds.length === 0)) {
      this.logger.event('log', 'Shopify customers/redact — nothing to erase (shop or customer not recognized)', 'ShopifyComplianceService', {
        shopDomain,
        resolved: matches.length > 0,
      });
      return { outcome: matches.length > 0 ? 'nothing_found' : 'unknown_shop', matchedIntegrations: matches.length };
    }

    // Each holder (live, or retained after a disconnect) is erased scoped to its own integration. Sequential: a failure
    // throws (non-2xx) so Shopify redelivers; erasure is idempotent, so holders already done are a no-op on retry.
    let found = 0;
    let canonicalCustomersRemoved = 0;
    let ordersErased = 0;
    for (const integration of matches) {
      const result = await this.integrationService.purgeCommerceCustomer(integration.workspaceId, integration.id, externalId, orderIds);
      found += result.found ? 1 : 0;
      canonicalCustomersRemoved += result.canonicalCustomerRemoved ? 1 : 0;
      ordersErased += result.ordersErased;
    }

    this.logger.event('log', 'Shopify customers/redact processed', 'ShopifyComplianceService', {
      shopDomain,
      matchedIntegrations: matches.length,
      found,
      canonicalCustomersRemoved,
      ordersErased,
    });
    return { outcome: found > 0 ? 'erased' : 'nothing_found', matchedIntegrations: matches.length };
  }

  /** Erases everything every matching integration holds for the shop; never just one picked by recency. */
  private async handleShopRedact(shopDomain: string): Promise<Outcome> {
    const matches = await this.integrationService.findAllByShopDomain(shopDomain);
    if (matches.length === 0) {
      this.logger.event('log', 'Shopify shop/redact — shop not recognized, nothing to erase', 'ShopifyComplianceService', { shopDomain });
      return { outcome: 'unknown_shop', matchedIntegrations: 0 };
    }

    for (const integration of matches) {
      await this.integrationService.eraseIntegrationForShopRedact(integration.id);
    }

    this.logger.event('log', 'Shopify shop/redact processed', 'ShopifyComplianceService', { shopDomain, matchedIntegrations: matches.length });
    return { outcome: 'erased', matchedIntegrations: matches.length };
  }
}
