import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, workspaceId } from './columns';
import { merchantKnowledgeEntries } from './merchant-knowledge-entries';

/**
 * One immutable snapshot per version of a merchant knowledge/policy entry
 * (doc13 versioning — see merchant-knowledge-entries' doc comment). A row
 * is inserted alongside every create/update, including version 1, so the
 * full history is always reconstructable from this table alone.
 */
export const merchantKnowledgeEntryHistory = pgTable('merchant_knowledge_entry_history', {
  id: id(),
  workspaceId: workspaceId(),
  entryId: uuid('entry_id')
    .notNull()
    .references(() => merchantKnowledgeEntries.id),
  version: integer('version').notNull(),
  type: text('type', { enum: ['knowledge', 'policy'] }).notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});
