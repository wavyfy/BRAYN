import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';

/**
 * Normalized product records from a connected provider (doc 22 — Commerce
 * data area: "Products"). Same ownership/normalization rules as
 * commerce_customers — see that table's doc comment.
 */
export const commerceProducts = pgTable(
  'commerce_products',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    provider: text('provider', {
      enum: ['shopify', 'woocommerce', 'website_tracking', 'whatsapp'],
    }).notNull(),
    /** Provider's own product id (Shopify `product.id`, etc.). */
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('commerce_products_workspace_provider_external_unique').on(
      table.workspaceId,
      table.provider,
      table.externalId,
    ),
  ],
);
