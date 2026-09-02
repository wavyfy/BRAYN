import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
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
    ...timestamps(),
  },
  (table) => [
    // Postgres treats every NULL as distinct in a unique index, so this only
    // constrains actual email collisions — any number of null-email rows coexist.
    uniqueIndex('canonical_customers_workspace_email_unique').on(table.workspaceId, table.primaryEmail),
  ],
);
