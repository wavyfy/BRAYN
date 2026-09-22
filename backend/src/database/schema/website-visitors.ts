import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { canonicalCustomers } from './canonical-customers';

/**
 * Website Behaviour domain (doc06/doc20 "Website Tracking"; doc22
 * "Website Behaviour" — owns "Anonymous visitors"). One row per anonymous
 * visitor identifier the tracking client generates and persists itself
 * (e.g. a long-lived cookie/localStorage id) — BRAYN never generates
 * this id, only records it.
 *
 * `canonicalCustomerId` is doc22's "Identity linkage references" slot —
 * present so the schema matches doc22 now. Anonymous → known identity
 * linking (doc09/doc20) is a separate, later part; nothing in this part
 * ever writes to this column.
 */
export const websiteVisitors = pgTable(
  'website_visitors',
  {
    id: id(),
    workspaceId: workspaceId(),
    visitorId: text('visitor_id').notNull(),
    canonicalCustomerId: uuid('canonical_customer_id').references(() => canonicalCustomers.id),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('website_visitors_workspace_visitor_unique').on(table.workspaceId, table.visitorId),
    index('website_visitors_canonical_customer_idx').on(table.canonicalCustomerId),
  ],
);
