import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';
import { canonicalCustomers } from './canonical-customers';

/**
 * External checkout sessions that ended without an order, as reported by a checkout provider (doc06 "External
 * Checkout & Payment Signal Sources"; doc21 `checkout.abandoned`). First source: FlexyPe `ABANDONED_CHECKOUT`.
 *
 * A signal, never commerce data: no order, no revenue, no amounts. Whether the shopper later completed the purchase is
 * read live from `commerce_orders.external_checkout_session_id` (the commerce platform stays the source of truth).
 * `stage` is the provider's last lifecycle stage verbatim — never upgraded into a payment outcome.
 *
 * Identity (doc09): `canonicalCustomerId` is set only by an exact email match to an EXISTING canonical customer (never
 * phone, never created). `email`/`phoneE164` are kept only while the session is unlinked — for a later link and for
 * erasure — and are cleared when it links or when the unmatched-retention window passes.
 */
export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    provider: text('provider', { enum: ['flexype'] }).notNull(),
    /** The provider's checkout session id (FlexyPe `payload.session_id`). */
    externalSessionId: text('external_session_id').notNull(),
    stage: text('stage').notNull(),
    /** When the provider reported the abandonment (FlexyPe `event_time`). */
    abandonedAt: timestamp('abandoned_at', { withTimezone: true }).notNull(),
    currency: text('currency'),
    itemCount: integer('item_count').notNull().default(0),
    email: text('email'),
    phoneE164: text('phone_e164'),
    canonicalCustomerId: uuid('canonical_customer_id').references(() => canonicalCustomers.id),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('checkout_sessions_integration_session_unique').on(
      table.integrationId,
      table.externalSessionId,
    ),
    index('checkout_sessions_workspace_session_idx').on(table.workspaceId, table.externalSessionId),
    index('checkout_sessions_workspace_canonical_idx').on(
      table.workspaceId,
      table.canonicalCustomerId,
    ),
    index('checkout_sessions_workspace_email_idx').on(table.workspaceId, table.email),
  ],
);
