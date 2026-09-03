import { integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';
import { commerceOrders } from './commerce-orders';
import { commerceProductVariants } from './commerce-product-variants';

/**
 * An order's line items (doc 20 Shopify Phase 1 Data — "Order line
 * items"). Belongs to a `commerce_orders` row; `variantId` is nullable
 * best-effort linkage to `commerce_product_variants` — same reasoning as
 * `commerce_orders.customerId` (the variant may not be imported/synced,
 * or may since have been deleted at the provider).
 */
export const commerceOrderLineItems = pgTable(
  'commerce_order_line_items',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    orderId: uuid('order_id')
      .notNull()
      .references(() => commerceOrders.id),
    variantId: uuid('variant_id').references(() => commerceProductVariants.id),
    provider: text('provider', {
      enum: ['shopify', 'woocommerce', 'website_tracking', 'whatsapp'],
    }).notNull(),
    /** Provider's own line item id (Shopify `line_item.id`, etc.). */
    externalId: text('external_id').notNull(),
    quantity: integer('quantity').notNull(),
    price: text('price'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('commerce_order_line_items_workspace_provider_external_unique').on(
      table.workspaceId,
      table.provider,
      table.externalId,
    ),
  ],
);
