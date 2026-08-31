import { pgTable, text } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns';

/**
 * A user's BRAYN identity, linked to their Clerk account (doc 05 — User).
 * Deliberately minimal: only the identity linkage needed to resolve "who
 * is this Clerk session for" into a domain record. Email/name/profile
 * fields are not added until a part actually needs them (Clerk already
 * owns that data; duplicating it here without a consumer is premature).
 * Workspace membership and roles land in a later Phase 2 part.
 */
export const users = pgTable('users', {
  id: id(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  ...timestamps(),
});
