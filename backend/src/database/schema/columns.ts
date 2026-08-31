import { timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Shared column conventions for domain tables (doc 22 — Base conventions,
 * Schema Principles). Ready for every domain to build on so each table
 * follows the same primary-key, timestamp, and tenant-scoping shape
 * rather than inventing its own.
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
 *
 * Deliberately no `.references()` here: this is a shared base module and
 * must not import a specific domain table (that would make every table
 * using it depend on `workspaces.ts`, which itself depends on this file
 * for `id`/`timestamps` — a circular import). Call sites that need FK
 * enforcement add `.references(() => workspaces.id)` themselves.
 */
export const workspaceId = () => uuid('workspace_id').notNull();
