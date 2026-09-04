import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id } from './columns';

/**
 * A durable record of a Shopify `customers/data_request` compliance
 * webhook, for manual handling (Shopify Protected Customer Data — the
 * merchant must be able to fulfil a customer's data-access request; this
 * is not an automated export, just the smallest inspectable trail of
 * "who asked, for what, when").
 *
 * `workspaceId`/`integrationId` are nullable and carry no FK — a
 * compliance webhook can arrive for a `shop_domain` BRAYN never
 * recognizes (already erased via `shop/redact`, or never actually
 * connected), and Shopify's requirement to acknowledge the request is
 * unconditional. A row must still be recorded and answered with 2xx even
 * when the shop can't be resolved to a workspace. Deliberately no FK to
 * `integrations` either, so this record survives a later `shop/redact`
 * erasure of that integration — the record that the request was received
 * must outlive the data it was about.
 *
 * Carries the customer identifiers Shopify's payload provides
 * (`shopify_customer_id`/`customer_email`) because they're exactly what a
 * human needs to act on the request — this is the legitimate business
 * record, not a log line; nothing here is ever written through
 * `StructuredLoggerService`. No `updatedAt`: immutable, write-once, same
 * as `protected_data_access_log`.
 */
export const customerDataRequests = pgTable(
  'customer_data_requests',
  {
    id: id(),
    workspaceId: uuid('workspace_id'),
    integrationId: uuid('integration_id'),
    provider: text('provider', { enum: ['shopify'] }).notNull(),
    shopDomain: text('shop_domain').notNull(),
    shopifyCustomerId: text('shopify_customer_id').notNull(),
    customerEmail: text('customer_email'),
    /** Shopify's `orders_requested` — order ids the customer's request covers, if any. */
    ordersRequested: jsonb('orders_requested'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('customer_data_requests_workspace_idx').on(table.workspaceId)],
);
