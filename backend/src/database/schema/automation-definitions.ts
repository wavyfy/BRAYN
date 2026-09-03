import { boolean, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';

/**
 * An automation rule (doc16 — Business Action Automation; doc19 Phase 15
 * items 1/2/3/6 — definition, trigger, conditions, actions). Phase 1
 * wires exactly one real trigger/action pair: `revenue_opportunity.created`
 * → `generate_recommendations`. Both are kept as enums (not hardcoded)
 * so extending them later is a migration, not a rewrite — but only one
 * value exists in each today because that's the only trigger event
 * BRAYN actually emits (see CustomerHealthService/RevenueOpportunityService)
 * paired with the only low-risk, no-approval-needed action available
 * (see AutomationService's doc comment for why nothing else qualifies
 * yet — no AI Action Control, no communication channel).
 *
 * `conditions` is a deliberately narrow first-pass filter — doc16
 * "Conditions determine whether an automation should continue" using
 * "Revenue Opportunity Detector" signals; see AutomationService's
 * `matchesConditions` for the exact (small) shape. Not a general rule
 * engine — that's unexercised abstraction ahead of a second trigger type
 * actually needing one (doc18).
 */
export const automationDefinitions = pgTable('automation_definitions', {
  id: id(),
  workspaceId: workspaceId(),
  name: text('name').notNull(),
  triggerType: text('trigger_type', { enum: ['revenue_opportunity.created'] }).notNull(),
  /** `{ priorityIn?: string[]; typeIn?: string[] }` — both optional, AND'd together; absent = always matches. */
  conditions: jsonb('conditions'),
  actionType: text('action_type', { enum: ['generate_recommendations'] }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  ...timestamps(),
});
