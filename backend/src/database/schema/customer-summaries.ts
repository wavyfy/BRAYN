import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';
import { users } from './users';

/**
 * A canonical customer's current AI-generated summary (doc08 "Customer
 * Summary" — "derived information and must not replace underlying
 * customer data"; doc12 — persisted AI output keeps its provenance).
 * One row per customer, overwritten on each manual regeneration (Slice
 * 4.5: no history, no scheduler). `sourceFingerprint` hashes the exact
 * input the model saw, so a later read can tell whether the customer's
 * data has changed since (stale). Never fed back into AI context.
 * Deleted by compliance erasure; a merged customer's row is deleted by
 * the merge (the survivor's turns stale on its own).
 */
export const customerSummaries = pgTable(
  'customer_summaries',
  {
    id: id(),
    workspaceId: workspaceId(),
    canonicalCustomerId: uuid('canonical_customer_id')
      .notNull()
      .references(() => canonicalCustomers.id),
    content: text('content').notNull(),
    provenance: text('provenance', { enum: ['ai_generated'] }).notNull().default('ai_generated'),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    sourceFingerprint: text('source_fingerprint').notNull(),
    /** Internal `users.id` of the merchant user who last (re)generated it. */
    generatedByUserId: uuid('generated_by_user_id')
      .notNull()
      .references(() => users.id),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (table) => [uniqueIndex('customer_summaries_workspace_canonical_unique').on(table.workspaceId, table.canonicalCustomerId)],
);
