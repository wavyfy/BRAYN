import { jsonb, pgTable, text, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
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
 * match, or a duplicate of a completed execution), `succeeded`,
 * `failed`. Execution is fully synchronous (the in-process EventBus, no
 * queue — see EventBus's doc comment) with no scheduling/delay, so
 * Pending/Evaluating/Executing never persist as their own row — there's
 * no gap in time for them to be observed in. `createdAt` (from
 * `timestamps()`) doubles as both the start and completion time.
 *
 * Retry (doc16 decision, Nov 2, 2026) is manual and append-only: a retry
 * is a new row with `retryOfRunId` pointing at the failed run it retries,
 * the same `triggerEventId` (so the same idempotency scope), and the same
 * stored `actionInput` — never rebuilt from mutable event/opportunity state.
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
  /** Action-specific result, e.g. `{ recommendationsCount }` or `{ notificationId }`. On a failed run, `{ retryable }` (false for permanent failures). Null when skipped. */
  result: jsonb('result'),
  /** The action input this run executed with, e.g. `{ opportunityId }` — what a retry re-executes. Null when skipped by conditions, and on runs recorded before retry existed. */
  actionInput: jsonb('action_input'),
  /** The failed run this run retries; null for a run started by its trigger. */
  retryOfRunId: uuid('retry_of_run_id').references((): AnyPgColumn => automationRuns.id),
  ...timestamps(),
});
