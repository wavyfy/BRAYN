import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';

export const webhookEventStatuses = ['pending', 'processing', 'processed', 'dead_letter'] as const;

/**
 * One row per accepted webhook delivery — and the durable work item for
 * processing it (doc 06/21 — Webhook Processing: persist safely; doc 07 —
 * Job Lifecycle; doc 22 — Integrations owns "Webhook state"). The row,
 * not any in-memory event, is the source of truth: WebhookIngestService
 * acknowledges a delivery only once this row is committed, and
 * WebhookEventProcessorService claims and processes rows from here.
 *
 * The unique (integration, externalEventId) index IS the delivery dedup:
 * a redelivery's insert conflicts and is acknowledged as a duplicate,
 * whatever state the original row is in.
 *
 * Lifecycle:
 *   pending ──claim──▶ processing ──success──▶ processed
 *      ▲                   │
 *      └──failure (backoff via nextAttemptAt)──┤
 *                          └──failure, attempts exhausted──▶ dead_letter ──replay──▶ pending
 *   processing whose lease (`lockedUntil`) expired (crashed worker) is claimable again.
 *
 * `claimToken` fences each claim: a worker's outcome is only written while
 * the row still carries the token it claimed with, so a worker that
 * outlived its lease can't overwrite a newer claim's state.
 * `retryCount` counts claims (processing attempts) so far.
 * `payload` holds the normalized `WebhookResourceEvent` (doc 21/18 —
 * "Replay where safe" without re-fetching from the provider).
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
    status: text('status', { enum: webhookEventStatuses }).notNull().default('pending'),
    payload: jsonb('payload'),
    retryCount: integer('retry_count').notNull().default(0),
    error: text('error'),
    /** Earliest time a `pending` row may be claimed — now() on insert, pushed out by retry backoff. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** Lease end for a `processing` row; past it, the claim is treated as abandoned and reclaimable. */
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    /** Fencing token of the current claim; null when no claim is held. */
    claimToken: uuid('claim_token'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('integration_webhook_events_integration_event_unique').on(table.integrationId, table.externalEventId),
    index('integration_webhook_events_workspace_idx').on(table.workspaceId),
    index('integration_webhook_events_claim_idx').on(table.status, table.nextAttemptAt),
  ],
);
