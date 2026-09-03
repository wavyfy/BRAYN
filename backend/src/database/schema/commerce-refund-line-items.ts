import { integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';
import { commerceRefunds } from './commerce-refunds';
import { commerceOrderLineItems } from './commerce-order-line-items';

/**
 * A refund's line items (Shopify `refund.refund_line_items`). Belongs to
 * a `commerce_refunds` row; `orderLineItemId` is nullable best-effort
 * linkage to `commerce_order_line_items` — same reasoning as
 * `commerce_order_line_items.variantId`.
 */
export const commerceRefundLineItems = pgTable(
  'commerce_refund_line_items',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => commerceRefunds.id),
    orderLineItemId: uuid('order_line_item_id').references(() => commerceOrderLineItems.id),
    provider: text('provider', {
      enum: ['shopify', 'woocommerce', 'website_tracking', 'whatsapp'],
    }).notNull(),
    /** Provider's own refund line item id (Shopify `refund_line_item.id`, etc.). */
    externalId: text('external_id').notNull(),
    quantity: integer('quantity').notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('commerce_refund_line_items_workspace_provider_external_unique').on(
      table.workspaceId,
      table.provider,
      table.externalId,
    ),
  ],
);
