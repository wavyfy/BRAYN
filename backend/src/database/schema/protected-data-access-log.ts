import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, workspaceId } from './columns';
import { users } from './users';

/**
 * A durable, queryable record that a staff member accessed customer
 * personal data (Shopify Protected Customer Data — "do you log access to
 * personal data?"). Written by `ProtectedDataAccessInterceptor` only for
 * routes carrying `@LogsProtectedAccess(...)` (Part 2's owner/admin-only
 * customer/conversation/identity-duplicate surface), only after the
 * handler completes successfully — never for a 401/403, and never for a
 * request that fails inside the handler.
 *
 * Deliberately metadata-only — no email/phone/name/message content/query
 * strings/request or response bodies are ever written here.
 * `resourceId` is an opaque UUID (a route param, never a search/query
 * value), null for list-level access with no single target.
 *
 * No `updatedAt`: rows are immutable, write-once — the shared
 * `timestamps()` helper would add a column nothing ever updates.
 */
export const protectedDataAccessLog = pgTable('protected_data_access_log', {
  id: id(),
  workspaceId: workspaceId(),
  /** Internal `users.id` — not the Clerk external sub. */
  actorUserId: uuid('actor_user_id')
    .notNull()
    .references(() => users.id),
  /** Snapshot of the actor's workspace role at access time — roles can change later; this reflects what it was then. */
  actorRole: text('actor_role', { enum: ['owner', 'admin', 'marketing', 'support', 'analyst'] }).notNull(),
  action: text('action', { enum: ['view', 'create'] }).notNull(),
  resourceType: text('resource_type', { enum: ['customer', 'customer_activity', 'conversation', 'identity_duplicate'] }).notNull(),
  resourceId: uuid('resource_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
