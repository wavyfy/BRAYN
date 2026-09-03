import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { automationDefinitions } from './automation-definitions';
import { canonicalCustomers } from './canonical-customers';

/**
 * One execution record per trigger match (doc16 — "Execution history";
 * doc19 Phase 15 item 8; doc07 event/job observability).
 *
 * Only three of doc16's fuller workflow-state vocabulary
 * (Pending/Evaluating/Scheduled/Executing/Succeeded, failure path
 * Failed/Retry) are ever written here: `skipped` (conditions didn't
 * match), `succeeded`, `failed`. Execution today is fully synchronous
 * (the in-process EventBus, no queue — see EventBus's doc comment) with
 * no scheduling/delay and no retry (doc19 Phase 15 items 5/9, deferred —
 * see AutomationService's doc comment), so Pending/Evaluating/Executing/
 * Retry never persist as their own row — there's no gap in time for them
 * to be observed in. `createdAt` (from `timestamps()`) doubles as both
 * the start and completion time for this reason.
 */
export const automationRuns = pgTable('automation_runs', {
  id: id(),
  workspaceId: workspaceId(),
  automationId: uuid('automation_id')
    .notNull()
    .references(() => automationDefinitions.id),
  canonicalCustomerId: uuid('canonical_customer_id')
    .notNull()
    .references(() => canonicalCustomers.id),
  /** The triggering DomainEvent's own `id` (doc07 — event id for traceability). */
  triggerEventId: text('trigger_event_id').notNull(),
  status: text('status', { enum: ['skipped', 'succeeded', 'failed'] }).notNull(),
  /** Why skipped, or the error message on failure. Null on success. */
  reason: text('reason'),
  /** Action-specific result, e.g. `{ recommendationsCount }`. Null when skipped/failed. */
  result: jsonb('result'),
  ...timestamps(),
});
