import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';
import { users } from './users';

/**
 * Identity review signals (doc 09 Matching Rules) — what flagged a pair:
 * - `phone`: two canonical customers share an E.164 phone (possible match).
 * - `email_conflict`: an already-linked source customer's email now
 *   belongs to a *different* canonical customer.
 * - `website_email_conflict`: an already-linked website visitor sent a
 *   verified email belonging to a *different* canonical customer.
 * The two conflict signals are doc09's "Conflicting identity signals
 * require explicit handling" — recorded for review, never re-linked.
 */
export const identityReviewSignals = ['phone', 'email_conflict', 'website_email_conflict'] as const;
export type IdentityReviewSignal = (typeof identityReviewSignals)[number];

/**
 * Phase 1 confidence levels (doc 09 — "Confidence evaluation"): `high` =
 * deterministic (exact normalized email); `medium` = possible (exact E.164
 * phone). Names and other weak signals are never used. Nothing here is
 * ever merged automatically — see IdentityResolutionService.
 */
export const identityConfidenceLevels = ['high', 'medium'] as const;
export type IdentityConfidence = (typeof identityConfidenceLevels)[number];

/**
 * A flagged pair for human review (doc 09 — "Duplicate Customers":
 * "Potential duplicates must not be silently merged based on uncertain
 * matches. The system should support: Detection, Confidence evaluation,
 * Safe merge, Conflict handling, Audit/history preservation").
 *
 * `canonicalCustomerAId` is always the lexicographically smaller of the
 * pair's two ids, so the same pair is never recorded twice regardless of
 * which side was resolved first. The unique index also means a reviewed
 * (dismissed/merged) pair is never re-created by later detection runs.
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
    matchedSignal: text('matched_signal', { enum: identityReviewSignals }).notNull(),
    confidence: text('confidence', { enum: identityConfidenceLevels }).notNull(),
    /**
     * The shared value itself — lets a reviewer see *why* without
     * re-deriving it. For "phone", the E.164 value (`commerce_customers.
     * phoneE164`); rows flagged before E.164 normalization keep the raw
     * provider value they were recorded with. For the conflict signals,
     * the normalized email.
     */
    matchedValue: text('matched_value').notNull(),
    status: text('status', { enum: ['pending', 'dismissed', 'merged', 'superseded'] })
      .notNull()
      .default('pending'),
    /** Internal `users.id` of the owner/admin who dismissed or merged this pair; null while pending. */
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
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
