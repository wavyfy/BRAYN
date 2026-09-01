import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';

/**
 * One row per accepted webhook delivery (doc 06/21 — Webhook Processing:
 * persist safely, produce a domain event; doc 22 — Integrations owns
 * "Webhook state"). Duplicate deliveries are rejected before a row is
 * written here — see WebhookIngestService, which reserves an
 * IdempotencyService key first — so the unique index below is a
 * belt-and-braces DB-level backstop, not the primary dedup mechanism.
 */
export const integrationWebhookEvents = pgTable(
  'integration_webhook_events',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    externalEventId: text('external_event_id').notNull(),
    eventType: text('event_type').notNull(),
    status: text('status', { enum: ['received', 'processed', 'failed'] })
      .notNull()
      .default('received'),
    error: text('error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('integration_webhook_events_integration_event_unique').on(table.integrationId, table.externalEventId),
    index('integration_webhook_events_workspace_idx').on(table.workspaceId),
  ],
);
