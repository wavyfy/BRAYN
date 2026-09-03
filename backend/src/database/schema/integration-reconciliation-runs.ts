import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';

/**
 * One row per reconciliation attempt (doc 06/20 — Reconciliation: detect
 * and repair differences between provider state and BRAYN state; doc 07 —
 * Retry: reconciliation is one of the doc 06 mechanisms that recovers
 * from failures the retry/backoff layer (common/async/retry.ts) couldn't
 * resolve inline). Mirrors integration_import_runs' run-per-attempt shape
 * for the same reason: a reconciliation pass has its own progress and can
 * be retried independently of the integration's live sync status.
 *
 * `triggeredBy` matches doc 06's listed triggers exactly — nothing else
 * has been built to trigger one yet (no scheduler exists: doc 29 §32
 * defers queue/worker technology), so a caller states which trigger
 * applied rather than the framework inferring it.
 *
 * What "detect a discrepancy" and "repair a discrepancy" mean is
 * domain/provider-specific (Commerce doesn't exist yet) — this table only
 * tracks the run and its counts, the same scope boundary import runs use.
 */
export const integrationReconciliationRuns = pgTable(
  'integration_reconciliation_runs',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    status: text('status', { enum: ['running', 'succeeded', 'failed', 'partial'] })
      .notNull()
      .default('running'),
    triggeredBy: text('triggered_by', {
      enum: ['scheduled', 'sync_completion', 'detected_inconsistency', 'manual'],
    }).notNull(),
    recordsChecked: integer('records_checked').notNull().default(0),
    discrepanciesFound: integer('discrepancies_found').notNull().default(0),
    discrepanciesRepaired: integer('discrepancies_repaired').notNull().default(0),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    index('integration_reconciliation_runs_workspace_idx').on(table.workspaceId),
    index('integration_reconciliation_runs_integration_idx').on(table.integrationId),
  ],
);
