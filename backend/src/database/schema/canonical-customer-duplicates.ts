import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';

/**
 * A flagged potential duplicate pair (doc 09 — "Duplicate Customers":
 * "Potential duplicates must not be silently merged based on uncertain
 * matches. The system should support: Detection..."). Detection only —
 * confidence evaluation, safe merge, and conflict handling are deferred
 * to a later part; see IdentityResolutionService's doc comment.
 *
 * `canonicalCustomerAId` is always the lexicographically smaller of the
 * pair's two ids, so the same pair is never recorded twice regardless of
 * which side was resolved first.
 */
export const canonicalCustomerDuplicates = pgTable(
  'canonical_customer_duplicates',
  {
    id: id(),
    workspaceId: workspaceId(),
    canonicalCustomerAId: uuid('canonical_customer_a_id')
      .notNull()
      .references(() => canonicalCustomers.id),
    canonicalCustomerBId: uuid('canonical_customer_b_id')
      .notNull()
      .references(() => canonicalCustomers.id),
    /** The deterministic signal that flagged this pair (only "phone" today). */
    matchedSignal: text('matched_signal', { enum: ['phone'] }).notNull(),
    /** The shared value itself (e.g. the phone number) — lets a reviewer see *why* without re-deriving it. */
    matchedValue: text('matched_value').notNull(),
    status: text('status', { enum: ['pending', 'dismissed'] })
      .notNull()
      .default('pending'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('canonical_customer_duplicates_pair_signal_unique').on(
      table.workspaceId,
      table.canonicalCustomerAId,
      table.canonicalCustomerBId,
      table.matchedSignal,
    ),
  ],
);
