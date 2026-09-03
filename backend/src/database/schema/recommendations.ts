import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';
import { revenueOpportunities } from './revenue-opportunities';

/**
 * An actionable recommendation surfaced to the merchant (doc10 —
 * Recommendations: "based on Customer state, Revenue opportunities,
 * Customer signals, Merchant context, Business rules, AI reasoning where
 * appropriate").
 *
 * Phase 1: recommendations are generated 1:1 from open Revenue
 * Opportunities only — the one input above that's a real BRAYN source
 * today. Customer state (health score/category) is itself withheld (see
 * CustomerHealthService — insufficient signal coverage), Merchant context
 * has no domain yet (doc19 Phase 10), and AI reasoning has no domain yet
 * (doc19 Phase 11). Extending generation to those inputs is a later part
 * once each source exists, not scoped ahead of need (doc18).
 *
 * `sourceOpportunityId` is unique per workspace so a recommendation is
 * never regenerated for the same opportunity — including after it's been
 * dismissed (doc10's opportunity rule "Closed opportunities should not
 * reappear unless qualifying conditions change" applied the same way here).
 */
export const recommendations = pgTable(
  'recommendations',
  {
    id: id(),
    workspaceId: workspaceId(),
    canonicalCustomerId: uuid('canonical_customer_id')
      .notNull()
      .references(() => canonicalCustomers.id),
    sourceOpportunityId: uuid('source_opportunity_id')
      .notNull()
      .references(() => revenueOpportunities.id),
    text: text('text').notNull(),
    /** e.g. `{ opportunityType, confidence, priority, estimatedRevenue, reason }` — the signals the recommendation is derived from (doc19 Phase 7.3 "Supporting signals"). */
    supportingSignals: jsonb('supporting_signals').notNull(),
    state: text('state', { enum: ['active', 'dismissed', 'completed'] }).notNull().default('active'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedReason: text('closed_reason'),
    ...timestamps(),
  },
  (table) => [uniqueIndex('recommendations_workspace_opportunity_unique').on(table.workspaceId, table.sourceOpportunityId)],
);
