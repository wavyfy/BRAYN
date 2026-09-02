import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';

/**
 * Normalized collection records from a connected provider (doc 20 Shopify
 * Phase 1 Data — "Collections"). Same ownership/normalization rules as
 * commerce_customers — see that table's doc comment.
 *
 * Shopify has two distinct collection resources (CustomCollection,
 * SmartCollection) with no unified list endpoint, but a single unified
 * `collections/create`/`collections/update` webhook topic and identical
 * bare-object shape either way — see ShopifyAdapter.fetchCollections'
 * doc comment for how the two are merged behind one cursor.
 */
export const commerceCollections = pgTable(
  'commerce_collections',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    provider: text('provider', {
      enum: ['shopify', 'woocommerce', 'website_tracking', 'whatsapp'],
    }).notNull(),
    /** Provider's own collection id (Shopify `collection.id`, etc.). */
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('commerce_collections_workspace_provider_external_unique').on(
      table.workspaceId,
      table.provider,
      table.externalId,
    ),
  ],
);
