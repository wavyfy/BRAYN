import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns';

/**
 * One row per daily intelligence run (doc10 — "Daily recalculation as a
 * consistency mechanism"; Milestone #5 D2/D3/D5 daily part). System-level,
 * not workspace-scoped: one run covers every workspace's customers.
 *
 * Doubles as the run lock (doc26 Scheduled Processing — execution state
 * must be observable): the partial unique index allows at most one
 * `running` row across every process/instance. A crashed process leaves a
 * `running` row whose `heartbeat_at` stops moving; the next start expires
 * it (status `failed`) and inserts its own.
 */
export const intelligenceDailyRuns = pgTable(
  'intelligence_daily_runs',
  {
    id: id(),
    status: text('status', { enum: ['running', 'succeeded', 'partial', 'failed'] })
      .notNull()
      .default('running'),
    customersProcessed: integer('customers_processed').notNull().default(0),
    healthRecalculated: integer('health_recalculated').notNull().default(0),
    healthSkipped: integer('health_skipped').notNull().default(0),
    customersFailed: integer('customers_failed').notNull().default(0),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('intelligence_daily_runs_single_running').on(table.status).where(sql`${table.status} = 'running'`),
    index('intelligence_daily_runs_started_at_idx').on(table.startedAt),
  ],
);
