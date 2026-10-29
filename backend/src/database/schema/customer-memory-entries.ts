import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';
import { users } from './users';

/**
 * doc08 "Customer Memory" — memory must distinguish these four kinds of
 * information, and "uncertain inference must not silently become verified
 * customer fact". Provenance, not a user-facing taxonomy. Slice 4.1 only
 * ever writes `merchant_provided`; the rest are reserved for later sources.
 */
export const customerMemoryProvenances = ['source_backed', 'merchant_provided', 'derived', 'ai_generated'] as const;
export type CustomerMemoryProvenance = (typeof customerMemoryProvenances)[number];

export const customerMemoryStatuses = ['active', 'archived'] as const;

/**
 * Current state of one durable memory entry about a canonical customer
 * (doc08 UCIR — owned by Customer Intelligence). Never hard-deleted from
 * the normal UI: removal is `archived`. Only compliance erasure deletes
 * rows. Every create/edit/archive appends a `customer_memory_entry_history`
 * row in the same transaction (doc08 "Important changes must be auditable").
 *
 * An identity merge re-points `canonicalCustomerId` to the survivor,
 * keeping id/content/provenance/creator/createdAt; the merge history
 * snapshot records which customer each entry belonged to before.
 */
export const customerMemoryEntries = pgTable(
  'customer_memory_entries',
  {
    id: id(),
    workspaceId: workspaceId(),
    canonicalCustomerId: uuid('canonical_customer_id')
      .notNull()
      .references(() => canonicalCustomers.id),
    content: text('content').notNull(),
    provenance: text('provenance', { enum: customerMemoryProvenances }).notNull(),
    status: text('status', { enum: customerMemoryStatuses }).notNull().default('active'),
    /** Internal `users.id` of the merchant user who wrote the entry. */
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [index('customer_memory_entries_workspace_customer_idx').on(table.workspaceId, table.canonicalCustomerId)],
);
