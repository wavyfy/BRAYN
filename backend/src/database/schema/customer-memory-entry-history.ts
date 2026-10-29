import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, workspaceId } from './columns';
import { customerMemoryEntries, customerMemoryProvenances, customerMemoryStatuses } from './customer-memory-entries';
import { users } from './users';

/**
 * Append-only snapshot of a memory entry after every create/edit/archive
 * (same pattern as `merchant_knowledge_entry_history`). Never updated;
 * deleted only by compliance erasure, together with its entry.
 */
export const customerMemoryEntryHistory = pgTable('customer_memory_entry_history', {
  id: id(),
  workspaceId: workspaceId(),
  memoryEntryId: uuid('memory_entry_id')
    .notNull()
    .references(() => customerMemoryEntries.id),
  action: text('action', { enum: ['created', 'edited', 'archived'] }).notNull(),
  content: text('content').notNull(),
  provenance: text('provenance', { enum: customerMemoryProvenances }).notNull(),
  status: text('status', { enum: customerMemoryStatuses }).notNull(),
  /** Internal `users.id` of whoever made this change. */
  changedByUserId: uuid('changed_by_user_id')
    .notNull()
    .references(() => users.id),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});
