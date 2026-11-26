import { integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { id } from './columns';

/**
 * Durable audit + idempotency record of every verified Shopify compliance webhook (`customers/data_request`,
 * `customers/redact`, `shop/redact`), keyed by Shopify's per-delivery `X-Shopify-Webhook-Id`. It is the claim that
 * makes processing retry-safe: a delivery is acknowledged (2xx) only once its row reaches `processed`; a failure is
 * recorded as `failed` and answered non-2xx so Shopify redelivers and the next attempt reprocesses it.
 *
 * Deliberately no customer identifiers (no customer id, email or phone): an erased person must not be re-identifiable
 * from the audit trail. `customer_data_requests` holds the identifiers a data request needs. `matched_integrations = 0`
 * on a processed row marks a shop BRAYN could not resolve (`outcome = 'unknown_shop'`): acknowledged, as Shopify
 * requires, and visible for operator review. No FK to integrations or workspaces, so the record outlives a
 * `shop/redact` erasure.
 */
export const shopifyComplianceWebhooks = pgTable(
  'shopify_compliance_webhooks',
  {
    id: id(),
    webhookId: text('webhook_id').notNull(),
    topic: text('topic').notNull(),
    shopDomain: text('shop_domain').notNull(),
    /** Shopify's numeric `shop_id` from the payload: the stable store id, kept so an alias mismatch is diagnosable. */
    shopId: text('shop_id'),
    status: text('status', { enum: ['processing', 'processed', 'failed'] }).notNull(),
    /** `erased` | `nothing_found` | `recorded` | `unknown_shop`, set once processed. */
    outcome: text('outcome'),
    matchedIntegrations: integer('matched_integrations'),
    attempts: integer('attempts').notNull().default(1),
    /** Error category only (error name / Postgres code), never a message or payload value. */
    error: text('error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('shopify_compliance_webhooks_webhook_id_unique').on(table.webhookId)],
);
