import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { websiteVisitors } from './website-visitors';

/**
 * Website Behaviour domain (doc22 "Website Behaviour" — owns
 * "Sessions"). One row per browsing session, keyed by a session
 * identifier the tracking client generates itself — BRAYN never
 * generates this id, same as `website_visitors.visitorId`.
 */
export const websiteSessions = pgTable(
  'website_sessions',
  {
    id: id(),
    workspaceId: workspaceId(),
    visitorId: uuid('visitor_id')
      .notNull()
      .references(() => websiteVisitors.id),
    sessionKey: text('session_key').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastEventAt: timestamp('last_event_at', { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('website_sessions_workspace_session_unique').on(table.workspaceId, table.sessionKey),
    index('website_sessions_visitor_idx').on(table.workspaceId, table.visitorId),
  ],
);
