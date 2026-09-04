import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Single-use, 60-second handoff token for the Shopify OAuth `/start`
 * top-level navigation (doc 20 Part 4B — a browser navigation can't carry
 * an Authorization header, and the real Clerk JWT must never appear in a
 * URL). Only `tokenHash` (SHA-256 of the opaque token the frontend holds
 * briefly) is stored — never the raw token — so a database read alone
 * can never hand out a usable credential. `consumedAt` is set by the one
 * atomic conditional UPDATE that enforces single-use
 * (ShopifyOAuthHandoffService.consume) — this table has no other writer.
 */
export const shopifyOauthHandoffTokens = pgTable(
  'shopify_oauth_handoff_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    clerkUserId: text('clerk_user_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('shopify_oauth_handoff_tokens_workspace_idx').on(table.workspaceId)],
);
