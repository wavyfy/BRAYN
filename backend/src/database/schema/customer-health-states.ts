import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';

/**
 * A canonical customer's current Customer Risk & Engagement State (doc10
 * — "Maintains a continuously updated customer score representing
 * current relationship strength and business risk").
 *
 * `score` is computed from the available signals only, rescaled to 100%
 * (Milestone #5 D1) — see CustomerHealthService's doc comment; null only
 * when the customer has no purchase history and no website activity.
 * `signals` and `reasonCodes` are always populated, so every score is
 * explainable (doc10 — "Every score must be explainable from its
 * underlying signals").
 *
 * `healthCategory`: 'Critical' | 'At Risk' | 'Neutral' | 'Healthy' (D1);
 * `trend`: 'improving' | 'declining' | 'stable' | 'unknown'. Free text
 * columns — no migration needed for these values.
 */
export const customerHealthStates = pgTable(
  'customer_health_states',
  {
    id: id(),
    workspaceId: workspaceId(),
    canonicalCustomerId: uuid('canonical_customer_id')
      .notNull()
      .references(() => canonicalCustomers.id),
    /** 0-100, or null when the customer has no purchase history and no website activity. */
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
