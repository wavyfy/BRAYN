import { index, pgTable, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';
import { revenueOpportunities } from './revenue-opportunities';

/**
 * A workspace-level internal notification about one revenue opportunity
 * (doc10 Opportunity Lifecycle "Merchant / System Notification"; doc16
 * Actions "Internal notifications"). Decisions (user, Nov 2, 2026 — doc22,
 * doc24, doc28): owned by Customer Intelligence; created only by Business
 * Action Automation's `internal_notification.create` action; one per
 * opportunity; visible to every workspace role; no per-user delivery,
 * read/unread or dismiss state.
 *
 * Stores references only — type/priority/reason are resolved from the
 * opportunity at read time rather than duplicated (doc22), and no customer
 * name or other personal data is stored. Deleted with the customer during
 * erasure (IntegrationService's canonical-customer purge).
 */
export const internalNotifications = pgTable(
  'internal_notifications',
  {
    id: id(),
    workspaceId: workspaceId(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => revenueOpportunities.id),
    canonicalCustomerId: uuid('canonical_customer_id')
      .notNull()
      .references(() => canonicalCustomers.id),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('internal_notifications_workspace_opportunity_unique').on(table.workspaceId, table.opportunityId),
    index('internal_notifications_workspace_created_idx').on(table.workspaceId, table.createdAt),
  ],
);
