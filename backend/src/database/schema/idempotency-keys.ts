import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Cross-cutting idempotency ledger — not owned by any single domain, same
 * reasoning as pgvector in Step 5's migration. "Repeated delivery or
 * retry must not create duplicate business effects. Apply this to:
 * Webhooks, Events, Imports, Jobs, Actions" (doc 03 rule 5, doc 07).
 *
 * `key` is caller-supplied (a webhook delivery id, a client idempotency
 * token, ...) and must already be unique on its own — that's what makes
 * it a valid idempotency key.
 */
export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').primaryKey(),
  status: text('status', { enum: ['pending', 'completed'] })
    .notNull()
    .default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
