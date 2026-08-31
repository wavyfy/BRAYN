import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns';
import { users } from './users';
import { workspaces } from './workspaces';

/**
 * Links a user to a workspace with a role (doc 05 — User, Roles &
 * Permissions; doc 28 — the fixed catalog of Phase 1 roles). This is the
 * "Workspace Membership" step in the authorization flow (doc 05, doc 23):
 * Authenticated User -> Workspace Membership -> Required Permission ->
 * Action-Specific Policy. Permission enforcement itself is a later part.
 *
 * One membership row per (workspace, user) pair — a user holds exactly
 * one role per workspace today. Doc 05 leaves room for "one or more
 * roles/permission sets"; multi-role-per-membership isn't added until a
 * concrete requirement needs it (doc 28 defines no such case yet).
 */
export const workspaceMemberships = pgTable(
  'workspace_memberships',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role', {
      enum: ['owner', 'admin', 'marketing', 'support', 'analyst'],
    }).notNull(),
    ...timestamps(),
  },
  (table) => [uniqueIndex('workspace_memberships_workspace_user_unique').on(table.workspaceId, table.userId)],
);
