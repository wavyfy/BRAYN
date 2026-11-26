import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { id } from './columns';

/**
 * Durable audit + idempotency record of every verified Shopify compliance webhook (`customers/data_request`,
 * `customers/redact`, `shop/redact`), keyed by Shopify's per-delivery `X-Shopify-Webhook-Id`. It is the claim that
 * makes processing retry-safe: a delivery is acknowledged (2xx) only once its row reaches `processed`; a failure is
 * recorded as `failed` and answered non-2xx so Shopify redelivers and the next attempt reprocesses it.
 *
 * `payload` (the verified body, which can hold a customer's id/email/phone) is kept only while the delivery is not yet
 * done — so a failed or excepted delivery can be replayed after Shopify stops retrying — and cleared once it is
 * `processed` or `resolved`; the permanent audit carries no customer identifiers. A shop BRAYN cannot resolve, or a
 * domain that resolves to a different store id, is acknowledged (Shopify requires 2xx) but stays an open privacy
 * exception (`status = 'exception'`, `exception_reason`) until an operator resolves it — never `processed`. Open
 * `failed`/`exception` rows make the compliance monitor endpoint unhealthy. No FK to integrations or workspaces, so the
 * record outlives a `shop/redact` erasure.
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
    status: text('status', {
      enum: ['processing', 'processed', 'failed', 'exception', 'resolved'],
    }).notNull(),
    /** `erased` | `nothing_found` | `recorded` | `unknown_shop`, set once processed. */
    outcome: text('outcome'),
    matchedIntegrations: integer('matched_integrations'),
    attempts: integer('attempts').notNull().default(1),
    /** Error category only (error name / Postgres code), never a message or payload value. */
    error: text('error'),
    /** `unknown_shop` | `identity_conflict`, set with `status = 'exception'`. */
    exceptionReason: text('exception_reason'),
    payload: jsonb('payload'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** Operator's note on how an exception was handled (no customer identifiers). */
    resolutionNote: text('resolution_note'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('shopify_compliance_webhooks_webhook_id_unique').on(table.webhookId),
    index('shopify_compliance_webhooks_status_idx').on(table.status),
  ],
);
