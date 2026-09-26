import type { ReactNode } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { ApiErrorState } from '@/components/api-error-state';
import { PageBody, PageHeader } from '@/components/ui/page-header';
import { StatusDot, type BadgeTone } from '@/components/ui/status-badge';
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

const statusTone: Record<Integration['status'], BadgeTone> = {
  connected: 'success',
  syncing: 'info',
  error: 'danger',
  disconnected: 'neutral',
};

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
  description,
  integration,
  latestImport,
  canManage,
  connect,
}: {
  workspaceId: string;
  provider: string;
  providerLabel: string;
  description: string;
  integration: Integration | null;
  latestImport: ImportRun | null;
  canManage: boolean;
  connect: ReactNode;
}) {
  const isLive = integration && integration.status !== 'disconnected';
  const status = integration?.status ?? 'disconnected';

  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-4 px-5 pb-4 pt-5">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-sm font-semibold text-foreground/70 ring-1 ring-inset ring-border">
            {providerLabel.charAt(0)}
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">{providerLabel}</h2>
            <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
          </div>
        </div>
        <StatusDot tone={statusTone[status]} className="shrink-0 capitalize">
          {status}
        </StatusDot>
      </div>
      <div className="flex-1 border-t border-border bg-subtle/40 px-5 py-4">
        {!canManage ? (
          <p className="text-[13px] text-muted-foreground">{isLive ? `Connected. Ask an owner or admin to manage this integration.` : 'Not connected.'}</p>
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
      </div>
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
    <main>
      <PageHeader title="Integrations" description="The stores BRAYN imports customers, orders and products from." />

      <PageBody className="space-y-4">
        {searchParams.shopify === 'connected' && (
          <p role="status" className="rounded-lg bg-success/[0.07] px-3 py-2 text-[13px] text-success ring-1 ring-inset ring-success/20">
            Shopify connected.
          </p>
        )}
        {searchParams.shopify === 'error' && (
          <p role="alert" className="rounded-lg bg-danger/[0.06] px-3 py-2 text-[13px] text-danger ring-1 ring-inset ring-danger/20">
            {OAUTH_ERROR_REASONS[searchParams.reason ?? ''] ?? 'Could not connect Shopify. Please try again.'}
          </p>
        )}

      <div className="grid grid-cols-1 items-stretch gap-5 xl:grid-cols-2">
        <ProviderCard
          workspaceId={workspaceId}
          provider="shopify"
          providerLabel="Shopify"
          description="Customers, orders and products from your Shopify store."
          integration={shopify}
          latestImport={shopifyImport}
          canManage={canManage}
          connect={<ShopifyConnect workspaceId={workspaceId} />}
        />

        <ProviderCard
          workspaceId={workspaceId}
          provider="woocommerce"
          providerLabel="WooCommerce"
          description="Customers, orders and products from your WooCommerce store."
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
      </PageBody>
    </main>
  );
}
