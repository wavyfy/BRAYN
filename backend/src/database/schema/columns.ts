import { timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Shared column conventions for domain tables (doc 22 — Base conventions,
 * Schema Principles). No domain table exists yet; these are ready for
 * Phase 2+ to build on so every table follows the same primary-key,
 * timestamp, and tenant-scoping shape rather than each domain inventing
 * its own.
 */

export const id = () => uuid('id').primaryKey().defaultRandom();

export const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Every workspace-owned table must carry this column and every query
 * against it must filter by it — "Never trust a client-provided
 * workspace ID as the only isolation mechanism" (doc 03 rule 3, doc 18).
 * Not yet a foreign key: the `workspaces` table doesn't exist until
 * Phase 2. Add the `.references()` call once it does.
 */
export const workspaceId = () => uuid('workspace_id').notNull();
