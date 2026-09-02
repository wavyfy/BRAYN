import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './columns';
import { integrations } from './integrations';
import { canonicalCustomers } from './canonical-customers';

/**
 * Normalized customer records from a connected provider (doc 22 — Commerce
 * data area: "Customers/source customer references", "External provider
 * identifiers"). Owned by the Commerce domain, not Integration — doc 06
 * "After normalization, domain-specific data belongs to its respective
 * domain" — Integration only produces these rows via its import/webhook
 * pipeline.
 *
 * This is a source reference, not the canonical customer identity: doc 09
 * "Identity Resolution owns... Canonical customer identity". Two providers
 * in the same workspace may each have their own row for what is
 * eventually the same person — `canonicalCustomerId` is IdentityResolution-
 * Service's link to the one canonical identity they resolve to; null until
 * that service has processed this row (see its own doc comment for when).
 */
export const commerceCustomers = pgTable(
  'commerce_customers',
  {
    id: id(),
    workspaceId: workspaceId(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id),
    provider: text('provider', {
      enum: ['shopify', 'woocommerce', 'website_tracking', 'whatsapp'],
    }).notNull(),
    /** Provider's own customer id (Shopify `customer.id`, etc.) — dedupe/sync key alongside workspace+provider. */
    externalId: text('external_id').notNull(),
    email: text('email'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    phone: text('phone'),
    /** Provider's own last-modified timestamp — lets a re-import or webhook update tell "changed" from "already have this". */
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    canonicalCustomerId: uuid('canonical_customer_id').references(() => canonicalCustomers.id),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('commerce_customers_workspace_provider_external_unique').on(
      table.workspaceId,
      table.provider,
      table.externalId,
    ),
  ],
);
