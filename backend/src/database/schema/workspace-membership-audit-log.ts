import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, workspaceId } from './columns';
import { users } from './users';

/**
 * A durable, immutable record of workspace administrative/permission
 * changes (doc18 Audit — "Permission changes", "Administrative changes").
 * Same shape/conventions as `protected_data_access_log` (write-once, no
 * `updatedAt`, metadata-only — never secrets/tokens/credentials): a
 * separate purpose-built table rather than extending that one, since its
 * `action`/`resourceType` enums are specifically scoped to customer-PII
 * access and don't fit membership/role events — this codebase's own
 * convention is one small table per distinct audit concern (see also
 * `ai_action_requests`, `automation_runs`), not one shared generic log.
 *
 * Written only after the underlying membership/role/ownership operation
 * has already succeeded (never for a rejected/failed request) — same
 * "record after success" rule as `protected_data_access_log`. A write
 * failure here is logged and swallowed, never allowed to fail the
 * administrative operation that already happened — same convention as
 * `MerchantBusinessAnalystService.recordProtectedAccess` /
 * `ReadToolsService.recordAccess` / `AiActionControlService.audit`.
 */
export const workspaceMembershipAuditLog = pgTable('workspace_membership_audit_log', {
  id: id(),
  workspaceId: workspaceId(),
  /** Internal `users.id` of whoever performed the change — not the Clerk external sub. */
  actorUserId: uuid('actor_user_id')
    .notNull()
    .references(() => users.id),
  /** Snapshot of the actor's role at the time of the change — roles can change later; this reflects what it was then. */
  actorRole: text('actor_role', { enum: ['owner', 'admin', 'marketing', 'support', 'analyst'] }).notNull(),
  action: text('action', { enum: ['member_added', 'member_removed', 'role_changed', 'ownership_transferred'] }).notNull(),
  /** The member the change was about — always present for every action this table records. */
  targetUserId: uuid('target_user_id')
    .notNull()
    .references(() => users.id),
  /** Reduced, non-sensitive context only — e.g. `{ role }` for add/remove, `{ fromRole, toRole }` for a role change, `{ fromUserId }` for an ownership transfer. Never credentials/tokens/secrets. */
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
