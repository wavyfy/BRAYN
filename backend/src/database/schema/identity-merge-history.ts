import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';
import { canonicalCustomerDuplicates, identityConfidenceLevels, identityReviewSignals } from './canonical-customer-duplicates';
import { users } from './users';

/** One source record as it stood before a merge — enough to trace (and, later, manually reverse) the merge without the live rows. */
export interface MergeSnapshotSourceRecord {
  commerceCustomerId: string;
  provider: string;
  externalId: string;
  email: string | null;
  phone: string | null;
  phoneE164: string | null;
}

export interface MergeSnapshotCustomer {
  canonicalCustomerId: string;
  primaryEmail: string | null;
  createdAt: string;
  sourceRecords: MergeSnapshotSourceRecord[];
  websiteVisitorIds: string[];
  /** `customer_memory_entries` ids this customer owned before the merge (the merged side's are re-pointed to the survivor). Absent on merges recorded before customer memory existed. */
  memoryEntryIds?: string[];
}

export interface MergeSnapshot {
  surviving: MergeSnapshotCustomer;
  /** Plus the merged customer's current health state row (removed by the merge), or null if it had none. */
  merged: MergeSnapshotCustomer & { healthState: Record<string, unknown> | null };
}

/**
 * Append-only audit of every identity merge (doc 09 — "Merges must be
 * auditable"; doc 22 — Identity Resolution owns "Merge history", Audit &
 * History lists "Identity merges"). Never updated. `snapshot` captures
 * both customers' identifiers and source records *before* the merge, so
 * this history never depends on the merged customer's row staying
 * unchanged. No user-facing undo in Phase 1; the snapshot is what a future
 * controlled reversal would read.
 */
export const identityMergeHistory = pgTable('identity_merge_history', {
  id: id(),
  workspaceId: workspaceId(),
  survivingCanonicalCustomerId: uuid('surviving_canonical_customer_id')
    .notNull()
    .references(() => canonicalCustomers.id),
  mergedCanonicalCustomerId: uuid('merged_canonical_customer_id')
    .notNull()
    .references(() => canonicalCustomers.id),
  /** The review record the merge was approved from. */
  duplicateId: uuid('duplicate_id')
    .notNull()
    .references(() => canonicalCustomerDuplicates.id),
  /** Internal `users.id` of the owner/admin who approved the merge. */
  performedByUserId: uuid('performed_by_user_id')
    .notNull()
    .references(() => users.id),
  matchedSignal: text('matched_signal', { enum: identityReviewSignals }).notNull(),
  confidence: text('confidence', { enum: identityConfidenceLevels }).notNull(),
  /** Optional free-text reason the reviewer gave. */
  reason: text('reason'),
  snapshot: jsonb('snapshot').notNull().$type<MergeSnapshot>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
