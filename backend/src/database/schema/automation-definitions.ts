import { boolean, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';

/**
 * An automation rule (doc16 — Business Action Automation; doc19 Phase 15
 * items 1/2/3/6 — definition, trigger, conditions, actions). Two trigger
 * types — `revenue_opportunity.created` and `customer_health.recalculated`
 * — and two actions, both executed through AI Action Control
 * (`AutomationService.runOne()` → `executeForAutomation()`):
 * `generate_recommendations` (either trigger) and
 * `internal_notification.create` (#9, Nov 2, 2026 — revenue-opportunity
 * trigger only; createAutomationSchema rejects the health pairing). Both
 * are low-risk/no-approval; the registry's one high-risk action
 * (`order.refund_request`) is not available to automation. Kept as enums
 * (not hardcoded) so extending them later is a migration, not a rewrite.
 *
 * `conditions` is a deliberately narrow first-pass filter — doc16
 * "Conditions determine whether an automation should continue" using
 * "Revenue Opportunity Detector" signals; see AutomationService's
 * `matchesConditions` for the exact (small) shape. Not a general rule
 * engine — that's unexercised abstraction ahead of a trigger type
 * actually needing one (doc18). `customer_health.recalculated`
 * automations do not evaluate `conditions` at all yet — see
 * `matchesHealthConditions`'s doc comment in AutomationService for why.
 */
export const automationDefinitions = pgTable('automation_definitions', {
  id: id(),
  workspaceId: workspaceId(),
  name: text('name').notNull(),
  triggerType: text('trigger_type', { enum: ['revenue_opportunity.created', 'customer_health.recalculated'] }).notNull(),
  /** `{ priorityIn?: string[]; typeIn?: string[] }` — both optional, AND'd together; absent = always matches. Only meaningful for `revenue_opportunity.created` — see AutomationService. */
  conditions: jsonb('conditions'),
  actionType: text('action_type', { enum: ['generate_recommendations', 'internal_notification.create'] }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  ...timestamps(),
});
