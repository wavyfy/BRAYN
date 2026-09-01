import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps } from './columns';
import { workspaces } from './workspaces';

/**
 * The integration framework's core record (doc 06/20/22 — Integration
 * model, Connection lifecycle). One row per (workspace, provider): Phase 1
 * connects at most one account per provider per workspace.
 *
 * `status` only carries the two states this part's service actually
 * drives (connected/disconnected). The fuller doc 06 lifecycle
 * (connecting/syncing/healthy/error/reauth-required) is a TS-level enum
 * with no DB constraint behind it (see workspace_memberships.role), so
 * later parts (sync state, integration health) extend this list without a
 * migration — adding states before any code sets them would be
 * unexercised flexibility (doc 19: implement one part at a time).
 *
 * Provider credentials are deliberately not modeled here — doc 22
 * "Provider secrets must not be stored as ordinary application data";
 * secure credential storage lands with the first real provider (Phase 4).
 */
export const integrations = pgTable(
  'integrations',
  {
    id: id(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    provider: text('provider', {
      enum: ['shopify', 'woocommerce', 'website_tracking', 'whatsapp'],
    }).notNull(),
    status: text('status', { enum: ['connected', 'disconnected'] })
      .notNull()
      .default('connected'),
    /**
     * Encrypted credential payload (AES-256-GCM, app-level — see
     * common/crypto/credential-cipher.ts). Ciphertext only; the plaintext
     * never touches the database. Null until a provider connect flow
     * (Phase 4) calls IntegrationService.setCredentials(). Never selected
     * by list/connect/disconnect — see integrationPublicColumns.
     */
    credentials: text('credentials'),
    ...timestamps(),
  },
  (table) => [uniqueIndex('integrations_workspace_provider_unique').on(table.workspaceId, table.provider)],
);
