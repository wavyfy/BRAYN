import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';
import { commerceCollections } from './commerce-collections';
import { commerceProducts } from './commerce-products';

/**
 * Product-collection membership (Shopify's `Collect` resource). Unlike
 * commerce_collections, Shopify has no `collects/*` webhook topic — a
 * membership change only surfaces through reconciliation's periodic
 * re-fetch of `/collects.json`, not real-time (see CollectionService's
 * doc comment).
 *
 * `collectionId`/`productId` are notNull, not best-effort: a Collect row
 * is meaningless without both ends resolved, so CollectionService skips
 * writing one until they do (idempotent — picked up on the next
 * sync/reconcile once the missing side has been imported).
 */
export const commerceCollectionProducts = pgTable(
  'commerce_collection_products',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => commerceCollections.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => commerceProducts.id),
    provider: text('provider', {
      enum: ['shopify', 'woocommerce', 'website_tracking', 'whatsapp'],
    }).notNull(),
    /** Provider's own membership-link id (Shopify `collect.id`, etc.). */
    externalId: text('external_id').notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('commerce_collection_products_workspace_provider_external_unique').on(
      table.workspaceId,
      table.provider,
      table.externalId,
    ),
  ],
);
