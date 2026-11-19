import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, workspaceId } from './columns';
import { workspaces } from './workspaces';

export const erasedIdentifierKinds = ['email', 'source', 'order'] as const;
export type ErasedIdentifierKind = (typeof erasedIdentifierKinds)[number];

/**
 * Identifiers of a customer erased through person-level erasure, kept so imports, syncs, reconciliation and webhooks
 * never recreate them (Phase 1: blocked permanently). Never stores the identifier itself: `valueHmac` is
 * HMAC-SHA256 under `ERASURE_HMAC_SECRET` over the workspace id, the kind and the normalized value, so the table
 * holds no personal data and the same email erased in two workspaces can't be correlated.
 *
 * Kinds: `email` (trimmed, lower-cased), `source` (provider + provider customer id, guest `guest:<email>` keys
 * included), `order` (provider + provider order id — erased orders stay deleted).
 *
 * `keyId` fingerprints the secret a row was written with. The hashes can't be re-keyed (the values are gone), so a
 * different current secret makes ingestion for that workspace fail closed rather than silently re-import an erased
 * person — see ErasedIdentifierService.
 */
export const erasedCustomerIdentifiers = pgTable(
  'erased_customer_identifiers',
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id),
    kind: text('kind', { enum: erasedIdentifierKinds }).notNull(),
    valueHmac: text('value_hmac').notNull(),
    keyId: text('key_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('erased_customer_identifiers_workspace_kind_value_unique').on(table.workspaceId, table.kind, table.valueHmac)],
);
