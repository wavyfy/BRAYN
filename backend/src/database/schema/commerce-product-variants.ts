import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';
import { commerceProducts } from './commerce-products';

/**
 * A product's purchasable variants (doc 20 Shopify Phase 1 Data —
 * "Products, Variants"). Belongs to a `commerce_products` row; deduped on
 * the same (workspace, provider, externalId) shape as its parent.
 *
 * ponytail: `price` is stored as the provider's raw string, not a
 * numeric/cents-integer column — avoids picking a rounding/currency
 * representation before anything actually computes with it. Revisit once
 * a real money calculation (totals, discounts) needs this column.
 */
export const commerceProductVariants = pgTable(
  'commerce_product_variants',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    productId: uuid('product_id')
      .notNull()
      .references(() => commerceProducts.id),
    provider: text('provider', {
      enum: ['shopify', 'woocommerce', 'website_tracking', 'whatsapp'],
    }).notNull(),
    /** Provider's own variant id (Shopify `variant.id`, etc.). */
    externalId: text('external_id').notNull(),
    sku: text('sku'),
    price: text('price'),
    inventoryQuantity: integer('inventory_quantity'),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('commerce_product_variants_workspace_provider_external_unique').on(
      table.workspaceId,
      table.provider,
      table.externalId,
    ),
  ],
);
