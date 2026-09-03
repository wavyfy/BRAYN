import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';

/**
 * A conversation with a customer (doc15 — "A conversation represents an
 * ongoing communication context with a customer"; doc19 Phase 9 item 1,
 * "Conversation foundation").
 *
 * `canonicalCustomerId` is required, not nullable — doc15's "Resolve the
 * customer identity where possible" implies conversations can start
 * unresolved (anonymous), but BRAYN has no anonymous-identity concept yet
 * (see IdentityResolutionService's doc comment — "anonymous→known linking
 * are deferred to later parts"). Modeling an unresolved conversation now
 * would be speculative flexibility with nothing to exercise it (doc18 —
 * no speculative build-ahead); this column becomes nullable when that
 * capability actually exists.
 *
 * `channel` only has one Phase 1 value (doc15 — "Phase 1: WhatsApp through
 * WAPon") — kept as an enum (not a free string) because doc15 names it as
 * a fixed concept, same reasoning as `revenue_opportunities.type`.
 */
export const conversations = pgTable('conversations', {
  id: id(),
  workspaceId: workspaceId(),
  canonicalCustomerId: uuid('canonical_customer_id')
    .notNull()
    .references(() => canonicalCustomers.id),
  channel: text('channel', { enum: ['whatsapp'] }).notNull(),
  status: text('status', { enum: ['open', 'closed'] }).notNull().default('open'),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  ...timestamps(),
});
