import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';
import { commerceOrders } from './commerce-orders';

/**
 * Normalized fulfilment records from a connected provider (doc 20 Shopify
 * Phase 1 Data — "Fulfilment events"). Belongs to a `commerce_orders` row.
 *
 * Unlike commerce_refunds, Shopify also embeds `order.fulfillments[]`
 * *and* has dedicated `fulfillments/create`/`fulfillments/update` webhook
 * topics whose payload is the bare fulfillment (with `order_id`, no
 * nested order) — so this is written both from the order
 * import/sync/reconciliation pipeline (OrderService.upsertMany, same as
 * refunds) and from its own webhook case (OrderService.upsertFulfillments)
 * — see OrderService's doc comment.
 *
 * ponytail: no per-fulfillment line items — doc 20 asks for fulfilment
 * *events* (status/tracking), not item-level fulfilment detail; add a
 * commerce_fulfillment_line_items table if a real need for that surfaces.
 */
export const commerceFulfillments = pgTable(
  'commerce_fulfillments',
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
    /** Provider's own fulfillment id (Shopify `fulfillment.id`, etc.). */
    externalId: text('external_id').notNull(),
    /** Provider's fulfillment status (Shopify: success/cancelled/error/pending, etc.). */
    status: text('status'),
    trackingCompany: text('tracking_company'),
    trackingNumber: text('tracking_number'),
    trackingUrl: text('tracking_url'),
    /** Provider's shipment tracking status (Shopify: in_transit/delivered/etc.) — distinct from `status`. */
    shipmentStatus: text('shipment_status'),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('commerce_fulfillments_workspace_provider_external_unique').on(
      table.workspaceId,
      table.provider,
      table.externalId,
    ),
  ],
);
