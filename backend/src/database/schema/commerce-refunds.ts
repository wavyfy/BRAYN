import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';
import { commerceOrders } from './commerce-orders';

/**
 * Normalized refund records from a connected provider (doc 20 Shopify
 * Phase 1 Data — "Refunds"). Belongs to a `commerce_orders` row — Shopify
 * has no top-level refunds list/webhook; a refund only ever arrives
 * embedded in its order's payload (`order.refunds[]`, including in
 * `orders/updated` webhooks), so this is written from the same order
 * import/sync/webhook/reconciliation pipeline that already writes
 * `commerce_orders`, not a separate resource loop — see OrderService.
 *
 * ponytail: `totalRefunded` stored as the provider's raw string — see
 * commerce_product_variants' `price` column for why.
 */
export const commerceRefunds = pgTable(
  'commerce_refunds',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => commerceOrders.id),
    provider: text('provider', {
      enum: ['shopify', 'woocommerce', 'website_tracking', 'whatsapp'],
    }).notNull(),
    /** Provider's own refund id (Shopify `refund.id`, etc.). */
    externalId: text('external_id').notNull(),
    note: text('note'),
    totalRefunded: text('total_refunded'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('commerce_refunds_workspace_provider_external_unique').on(
      table.workspaceId,
      table.provider,
      table.externalId,
    ),
  ],
);
