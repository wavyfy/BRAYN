import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, workspaceId } from './columns';
import { workspaces } from './workspaces';

/**
 * Non-personal audit record of one person-level customer erasure: who ran it, when, and what was removed (counts
 * only). `canonicalCustomerId` is the erased (now deleted) customer's BRAYN id, deliberately without an FK so the
 * record outlives the data it was about. No email, name, phone or provider ids. Write-once, no `updatedAt`.
 */
export const customerErasures = pgTable(
  'customer_erasures',
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    /** Clerk user id of the owner who requested the erasure. */
    actorUserId: text('actor_user_id').notNull(),
    canonicalCustomerId: uuid('canonical_customer_id').notNull(),
    sourceCustomersErased: integer('source_customers_erased').notNull(),
    ordersErased: integer('orders_erased').notNull(),
    webhookPayloadsCleared: integer('webhook_payloads_cleared').notNull(),
    identifiersBlocked: integer('identifiers_blocked').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('customer_erasures_workspace_idx').on(table.workspaceId)],
);
