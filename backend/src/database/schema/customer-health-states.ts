import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';

/**
 * A canonical customer's current Customer Risk & Engagement State (doc10
 * — "Maintains a continuously updated customer score representing
 * current relationship strength and business risk").
 *
 * doc10's Phase 1 weight table needs signals BRAYN doesn't have yet
 * (website/WhatsApp engagement — no Website Behaviour/Conversation
 * domain; email engagement — explicitly "PENDING PRODUCT DECISION" in
 * the doc itself; customer experience — no source). Rather than emit a
 * score computed from half the spec'd formula, `score`/`healthCategory`/
 * `trend` stay null until enough signal coverage exists — see
 * CustomerHealthService's doc comment. `signals` and `reasonCodes` are
 * always populated from whatever's actually available, so even a null
 * score is explainable (doc10 — "Every score must be explainable from
 * its underlying signals").
 *
 * `healthCategory` is deliberately untyped free text: doc10 says "Fixed
 * Phase 1 health categories" exist but never names them anywhere in the
 * documentation — do not invent category names; get them from an
 * explicit product decision before this column's first real write.
 */
export const customerHealthStates = pgTable(
  'customer_health_states',
  {
    id: id(),
    workspaceId: workspaceId(),
    canonicalCustomerId: uuid('canonical_customer_id')
      .notNull()
      .references(() => canonicalCustomers.id),
    /** 0-100, or null when signal coverage is insufficient to compute a score doc10's weight table would stand behind. */
    score: integer('score'),
    healthCategory: text('health_category'),
    /** Every signal considered, available or not — e.g. `{ purchaseRecency: { value, weight, score }, websiteEngagement: { available: false, reason: "..." } }`. */
    signals: jsonb('signals').notNull(),
    reasonCodes: jsonb('reason_codes').notNull().$type<string[]>(),
    trend: text('trend'),
    lastCalculatedAt: timestamp('last_calculated_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [uniqueIndex('customer_health_states_workspace_canonical_unique').on(table.workspaceId, table.canonicalCustomerId)],
);
