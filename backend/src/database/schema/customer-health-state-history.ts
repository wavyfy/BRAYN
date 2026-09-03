import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';

/**
 * Append-only history of every Customer Risk & Engagement State
 * recalculation (doc10 — "Historical scores retained"). One row per
 * recalculation, never updated — `customer_health_states` holds the
 * current one. See that table's doc comment for why `score`/
 * `healthCategory` can be null.
 */
export const customerHealthStateHistory = pgTable('customer_health_state_history', {
  id: id(),
  workspaceId: workspaceId(),
  canonicalCustomerId: uuid('canonical_customer_id')
    .notNull()
    .references(() => canonicalCustomers.id),
  score: integer('score'),
  healthCategory: text('health_category'),
  signals: jsonb('signals').notNull(),
  reasonCodes: jsonb('reason_codes').notNull().$type<string[]>(),
  trend: text('trend'),
  calculatedAt: timestamp('calculated_at', { withTimezone: true }).notNull(),
  ...timestamps(),
});
