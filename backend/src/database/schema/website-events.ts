import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, workspaceId } from './columns';
import { websiteVisitors } from './website-visitors';
import { websiteSessions } from './website-sessions';

/** Doc20 Phase 1 storefront interaction events this part accepts and stores. */
export const websiteEventTypes = ['page_view', 'product_view', 'search', 'cart', 'checkout'] as const;

/**
 * Website Behaviour domain (doc22 "Website Behaviour" — owns "Behaviour
 * events"). Deliberately lean — no `timestamps()`/`updatedAt` — per
 * doc22's own guidance: "Large event datasets should be designed
 * separately from transactional customer records where appropriate."
 * An append-only, high-volume event log has no update lifecycle, so it
 * carries only `receivedAt` rather than the mutable createdAt/updatedAt
 * pair every other domain table uses.
 *
 * `eventId` is caller-supplied by the tracking client (its own delivery
 * id) — same idempotency shape as `integration_webhook_events.
 * externalEventId`: `WebsiteEventIngestService` reserves an
 * `IdempotencyService` key first, so the unique index below is a
 * belt-and-braces DB backstop, not the primary dedup mechanism.
 *
 * `eventType` covers doc20's Phase 1 storefront interaction events only.
 * "Session" and "Identity signals" (also listed in doc20) are not event
 * rows here — a session is `website_sessions` itself, and identity
 * signals are Identity Resolution's concern (doc09), not built by this
 * part.
 */
export const websiteEvents = pgTable(
  'website_events',
  {
    id: id(),
    workspaceId: workspaceId(),
    visitorId: uuid('visitor_id')
      .notNull()
      .references(() => websiteVisitors.id),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => websiteSessions.id),
    eventId: text('event_id').notNull(),
    eventType: text('event_type', { enum: websiteEventTypes }).notNull(),
    payload: jsonb('payload'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('website_events_workspace_event_unique').on(table.workspaceId, table.eventId),
    index('website_events_session_idx').on(table.workspaceId, table.sessionId),
    index('website_events_visitor_idx').on(table.workspaceId, table.visitorId),
    index('website_events_occurred_at_idx').on(table.workspaceId, table.occurredAt),
  ],
);
