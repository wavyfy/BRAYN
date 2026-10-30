import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';
import { customerMemoryProvenances, customerMemoryStatuses } from './customer-memory-entries';
import { users } from './users';

/** doc08 "Customer Preferences" examples, as a fixed category (user decision, Slice 4.2). */
export const customerPreferenceCategories = ['communication', 'product', 'behavioural', 'interaction'] as const;
export type CustomerPreferenceCategory = (typeof customerPreferenceCategories)[number];

/**
 * A known customer preference (doc08 UCIR — owned by Customer Intelligence;
 * "Preference provenance should be retained where relevant"). Same
 * provenance/lifecycle rules as `customer_memory_entries`: Slice 4.2 only
 * writes `merchant_provided`; removal is `archived`, only compliance
 * erasure deletes rows; every create/edit/archive appends a
 * `customer_preference_history` row in the same transaction; an identity
 * merge re-points `canonicalCustomerId` to the survivor unchanged otherwise.
 */
export const customerPreferences = pgTable(
  'customer_preferences',
  {
    id: id(),
    workspaceId: workspaceId(),
    canonicalCustomerId: uuid('canonical_customer_id')
      .notNull()
      .references(() => canonicalCustomers.id),
    category: text('category', { enum: customerPreferenceCategories }).notNull(),
    content: text('content').notNull(),
    provenance: text('provenance', { enum: customerMemoryProvenances }).notNull(),
    status: text('status', { enum: customerMemoryStatuses }).notNull().default('active'),
    /** Internal `users.id` of the merchant user who recorded the preference. */
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [index('customer_preferences_workspace_customer_idx').on(table.workspaceId, table.canonicalCustomerId)],
);

/** Append-only snapshot of a preference after every create/edit/archive; deleted only by compliance erasure. */
export const customerPreferenceHistory = pgTable('customer_preference_history', {
  id: id(),
  workspaceId: workspaceId(),
  preferenceId: uuid('preference_id')
    .notNull()
    .references(() => customerPreferences.id),
  action: text('action', { enum: ['created', 'edited', 'archived'] }).notNull(),
  category: text('category', { enum: customerPreferenceCategories }).notNull(),
  content: text('content').notNull(),
  provenance: text('provenance', { enum: customerMemoryProvenances }).notNull(),
  status: text('status', { enum: customerMemoryStatuses }).notNull(),
  /** Internal `users.id` of whoever made this change. */
  changedByUserId: uuid('changed_by_user_id')
    .notNull()
    .references(() => users.id),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
});
