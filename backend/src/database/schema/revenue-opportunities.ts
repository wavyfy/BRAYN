import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';

/**
 * A detected revenue opportunity (doc10 — Revenue Opportunity Detector).
 * Phase 1: only the three types computable from Commerce data alone —
 * `reorder`, `win_back`, `vip_recognition` — see RevenueOpportunityService's
 * doc comment for why cross_sell/upsell/bundle/review_request/referral
 * aren't produced yet (product-affinity logic and data sources that
 * don't exist). Extending the `type`/`status`/`priority` enums is a
 * trivial migration once a real signal source exists — not scoped ahead
 * of need (doc18 — no speculative build-ahead).
 *
 * `status`/`priority` use doc10's full fixed vocabulary even though
 * detection only ever produces `status: 'new'` today — those are doc10's
 * own spec'd values, not invented here; later parts (manual review,
 * Business Action Automation) drive the other transitions.
 */
export const revenueOpportunities = pgTable('revenue_opportunities', {
  id: id(),
  workspaceId: workspaceId(),
  canonicalCustomerId: uuid('canonical_customer_id')
    .notNull()
    .references(() => canonicalCustomers.id),
  type: text('type', { enum: ['reorder', 'win_back', 'vip_recognition'] }).notNull(),
  status: text('status', {
    enum: ['new', 'recommended', 'scheduled', 'executed', 'converted', 'expired', 'ignored'],
  })
    .notNull()
    .default('new'),
  priority: text('priority', { enum: ['critical', 'high', 'medium', 'low'] }).notNull(),
  /** Raw string, same convention as commerce_orders.totalPrice — no currency unit is tracked anywhere yet. Null when not applicable to this type (e.g. vip_recognition). */
  estimatedRevenue: text('estimated_revenue'),
  /** 0-100. */
  confidence: integer('confidence').notNull(),
  reason: text('reason').notNull(),
  recommendedAction: text('recommended_action').notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedReason: text('closed_reason'),
  ...timestamps(),
});
