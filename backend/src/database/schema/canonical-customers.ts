import { pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';

/**
 * The canonical customer identity (doc 09 — "Identity Resolution owns...
 * Canonical customer identity"; doc 04 — "Unified Customer Intelligence
 * Record owns the resulting unified customer intelligence", this table
 * owns *who the customer is*, not what BRAYN knows about them).
 *
 * Phase 1: linked from `commerce_customers` via exact, case-insensitive
 * email match within a workspace (doc 09 — "Prefer deterministic identity
 * signals... Do not merge solely on weak or ambiguous signals"). Phone
 * matching, duplicate detection/merge, and anonymous→known linking are
 * deferred to later parts — see IdentityResolutionService's doc comment.
 */
export const canonicalCustomers = pgTable(
  'canonical_customers',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** Trimmed + lowercased for case-insensitive matching; null when no source record has a deterministic email signal yet. */
    primaryEmail: text('primary_email'),
    /**
     * Set when an owner/admin merged this customer into another (doc 09
     * "Safe merge") — the row is kept, never deleted, so its identifiers
     * and history survive. Always points at a *surviving* customer (a
     * later merge of that survivor re-points every row merged into it), so
     * resolving through it is one hop. Resolution that lands on this row —
     * e.g. its `primaryEmail` seen again on a new source record — follows
     * it to the survivor instead of linking to (or re-creating) this one.
     */
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => canonicalCustomers.id),
    mergedAt: timestamp('merged_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    // Postgres treats every NULL as distinct in a unique index, so this only
    // constrains actual email collisions — any number of null-email rows coexist.
    uniqueIndex('canonical_customers_workspace_email_unique').on(table.workspaceId, table.primaryEmail),
  ],
);
