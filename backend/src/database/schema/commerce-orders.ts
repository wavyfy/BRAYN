import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';
import { commerceCustomers } from './commerce-customers';

/**
 * Normalized order records from a connected provider (doc 22 — Commerce
 * data area: "Orders"; doc 20 — "Required customer/order relationships").
 * Same ownership/normalization rules as commerce_customers — see that
 * table's doc comment.
 *
 * `customerId` is nullable: a guest-checkout order has no provider
 * customer to link (Shopify's own `order.customer` is nullable), and an
 * order can arrive before its customer has been imported/synced — this
 * column is best-effort linkage, not a guarantee.
 *
 * ponytail: `totalPrice` stored as the provider's raw string — see
 * commerce_product_variants' `price` column for why.
 */
export const commerceOrders = pgTable(
  'commerce_orders',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    customerId: uuid('customer_id').references(() => commerceCustomers.id),
    provider: text('provider', {
      enum: ['shopify', 'woocommerce', 'website_tracking', 'whatsapp'],
    }).notNull(),
    /** Provider's own order id (Shopify `order.id`, etc.). */
    externalId: text('external_id').notNull(),
    totalPrice: text('total_price'),
    /** Provider's last-modified time — moves on fulfillment/refund/edit, so it is NOT when the order was placed. */
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    /**
     * When the order was placed at the source (Shopify `Order.createdAt` —
     * set at checkout completion, never changes; WooCommerce
     * `date_created_gmt`). The authoritative time for business timing
     * (reorder gaps, recency, activity). `createdAt` is only when BRAYN
     * stored the row — a batch import gives every order the same one.
     * Null for rows imported before this column existed; see
     * `orderPlacedAt` for the fallback.
     */
    sourceCreatedAt: timestamp('source_created_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('commerce_orders_workspace_provider_external_unique').on(
      table.workspaceId,
      table.provider,
      table.externalId,
    ),
  ],
);

/**
 * When an order was placed, for any business-timing logic (reorder gaps,
 * recency, 90-day frequency, activity chronology). Source placement time
 * first; for a legacy row with no `sourceCreatedAt` yet, the provider's
 * last-modified time (still a source time), then BRAYN's own `createdAt`
 * only as the last resort. A full re-import backfills
 * `sourceCreatedAt`, so the fallbacks only apply to legacy rows. A new
 * fragment per call — mapped back to a Date like a real timestamp column.
 */
export const orderPlacedAt = () =>
  sql<Date>`coalesce(${commerceOrders.sourceCreatedAt}, ${commerceOrders.sourceUpdatedAt}, ${commerceOrders.createdAt})`.mapWith(
    commerceOrders.createdAt,
  );
