import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';

/**
 * One row per initial-import attempt for an integration (doc 06/20 —
 * Initial Import: progress tracking, pagination, retry, partial-failure
 * handling, import completion state). Separate from `integrations.status`
 * (doc 06 Sync state), which only carries a single current state — a
 * long-running import needs its own row so progress (records
 * imported/failed, pagination cursor) survives retries and stays visible
 * per attempt rather than being overwritten in place.
 *
 * What each provider actually imports (customers/orders/products) belongs
 * to Commerce once that domain exists (Phase 4+) — this table only tracks
 * the run itself, not imported record content. Record-level deduplication
 * is likewise a Commerce-domain concern once there are records to dedupe
 * against; this framework part only guarantees a workspace can't have two
 * concurrent runs racing for the same integration.
 */
export const integrationImportRuns = pgTable(
  'integration_import_runs',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    status: text('status', { enum: ['running', 'succeeded', 'failed', 'partial'] })
      .notNull()
      .default('running'),
    /** Opaque provider-specific pagination position, so a resumed/retried import doesn't restart from page 1. */
    cursor: text('cursor'),
    recordsImported: integer('records_imported').notNull().default(0),
    recordsFailed: integer('records_failed').notNull().default(0),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    index('integration_import_runs_workspace_idx').on(table.workspaceId),
    index('integration_import_runs_integration_idx').on(table.integrationId),
  ],
);
