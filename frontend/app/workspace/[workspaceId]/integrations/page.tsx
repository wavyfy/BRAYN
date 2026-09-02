import Link from 'next/link';
import type { ReactNode } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiErrorState } from '@/components/api-error-state';
import { ConnectForm } from './connect-form';
import { ShopifyConnect } from './shopify-connect';
import { IntegrationActions, type ImportRun } from './integration-actions';

type Integration = {
  id: string;
  provider: string;
  status: 'connected' | 'disconnected' | 'syncing' | 'error';
  lastSyncedAt: string | null;
  lastSyncError: string | null;
};
type WorkspaceSummary = { id: string; role: string };

const statusStyles: Record<Integration['status'], string> = {
  connected: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  syncing: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  error: 'bg-red-50 text-red-700 ring-red-600/20',
  disconnected: 'bg-slate-100 text-slate-700 ring-slate-500/20',
};

function StatusBadge({ status }: { status: Integration['status'] }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${statusStyles[status]}`}>
      {status}
    </span>
  );
}

/**
 * One provider's card: connect form when there's no live connection,
 * status + import/disconnect controls when there is. `canManage` gates the
 * mutating controls only — GET is already visible to every member (doc 28
 * Phase 1 Permission Matrix — Integrations: Owner/Admin Manage, others View).
 */
function ProviderCard({
  workspaceId,
  provider,
  providerLabel,
  integration,
  latestImport,
  canManage,
  connect,
}: {
  workspaceId: string;
  provider: string;
  providerLabel: string;
  integration: Integration | null;
  latestImport: ImportRun | null;
  canManage: boolean;
  connect: ReactNode;
}) {
  const isLive = integration && integration.status !== 'disconnected';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>{providerLabel}</CardTitle>
        <StatusBadge status={integration?.status ?? 'disconnected'} />
      </CardHeader>
      <CardContent>
        {!canManage ? (
          <p className="text-sm text-slate-500">{isLive ? `Connected. Ask an owner or admin to manage this integration.` : 'Not connected.'}</p>
        ) : isLive ? (
          <IntegrationActions
            workspaceId={workspaceId}
            provider={provider}
            providerLabel={providerLabel}
            status={integration.status}
            lastSyncedAt={integration.lastSyncedAt}
            lastSyncError={integration.lastSyncError}
            latestImport={latestImport}
          />
        ) : (
          connect
        )}
      </CardContent>
    </Card>
  );
}

const OAUTH_ERROR_REASONS: Record<string, string> = {
  expired: 'That authorization link expired — try connecting again.',
  invalid_shop: 'Shopify returned an unexpected store domain.',
  invalid_signature: "Could not verify this request came from Shopify.",
  missing_code: 'Shopify did not send an authorization code.',
  token_exchange_failed: 'Shopify rejected the authorization code.',
  verification_failed: 'The new access token could not be verified against your store.',
};

/** Doc19 Phase 8 — Integration Connection UI: Shopify + WooCommerce connect/status/import/disconnect. */
export default async function IntegrationsPage({
  params,
  searchParams,
}: {
  params: { workspaceId: string };
  searchParams: { shopify?: string; reason?: string };
}) {
  const { workspaceId } = params;

  let integrations: Integration[], memberships: WorkspaceSummary[];
  try {
    [integrations, memberships] = await Promise.all([
      apiFetch(`/api/v1/workspaces/${workspaceId}/integrations`),
      apiFetch('/api/v1/users/me/workspaces'),
    ]);
  } catch (error) {
    if (error instanceof ApiError) {
      return <ApiErrorState status={error.status} message={error.message} backHref={`/workspace/${workspaceId}`} backLabel="Back to Workspace" />;
    }
    throw error;
  }

  const role = memberships.find((m) => m.id === workspaceId)?.role;
  const canManage = role === 'owner' || role === 'admin';

  const shopify = integrations.find((i) => i.provider === 'shopify') ?? null;
  const woocommerce = integrations.find((i) => i.provider === 'woocommerce') ?? null;

  const [shopifyImport, woocommerceImport] = await Promise.all([
    shopify && shopify.status !== 'disconnected' ? apiFetch(`/api/v1/workspaces/${workspaceId}/integrations/shopify/import`) : null,
    woocommerce && woocommerce.status !== 'disconnected' ? apiFetch(`/api/v1/workspaces/${workspaceId}/integrations/woocommerce/import`) : null,
  ]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link href={`/workspace/${workspaceId}`} className="text-sm text-slate-500 hover:text-slate-700">
        &larr; Workspace
      </Link>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">Integrations</h1>

      {searchParams.shopify === 'connected' && (
        <p className="mt-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
          Shopify connected.
        </p>
      )}
      {searchParams.shopify === 'error' && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-600/20">
          {OAUTH_ERROR_REASONS[searchParams.reason ?? ''] ?? 'Could not connect Shopify. Please try again.'}
        </p>
      )}

      <div className="mt-6 space-y-6">
        <ProviderCard
          workspaceId={workspaceId}
          provider="shopify"
          providerLabel="Shopify"
          integration={shopify}
          latestImport={shopifyImport}
          canManage={canManage}
          connect={<ShopifyConnect workspaceId={workspaceId} />}
        />

        <ProviderCard
          workspaceId={workspaceId}
          provider="woocommerce"
          providerLabel="WooCommerce"
          integration={woocommerce}
          latestImport={woocommerceImport}
          canManage={canManage}
          connect={
            <ConnectForm
              workspaceId={workspaceId}
              provider="woocommerce"
              providerLabel="WooCommerce"
              fields={[
                { name: 'storeUrl', label: 'Store URL', placeholder: 'https://your-store.com' },
                { name: 'consumerKey', label: 'Consumer key', placeholder: 'ck_…' },
                { name: 'consumerSecret', label: 'Consumer secret', placeholder: 'cs_…', type: 'password' },
              ]}
            />
          }
        />
      </div>
    </main>
  );
}
