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
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
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
