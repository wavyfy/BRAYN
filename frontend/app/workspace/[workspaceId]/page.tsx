import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { RenameWorkspaceForm } from './rename-workspace-form';
import { AddMemberForm } from './add-member-form';
import { MemberRowActions } from './member-row-actions';
import { Card } from '@/components/ui/card';
import { RoleBadge } from '@/components/ui/badge';
import { ApiErrorState } from '@/components/api-error-state';
import { PageBody, PageHeader } from '@/components/ui/page-header';
import { Metric, MetricStrip } from '@/components/ui/metric';
import { SectionHeader } from '@/components/ui/section';
import { StatusDot, type BadgeTone } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { LinkButton } from '@/components/ui/link-button';
import { ArrowRightIcon } from '@/components/ui/icons';
import { formatDate, formatDateTime, formatRelative, providerLabel } from '@/lib/format';

type Workspace = { id: string; name: string; createdAt: string };
type WorkspaceSummary = { id: string; name: string; role: string };
type Membership = { id: string; userId: string; role: string };
type CurrentUser = { id: string };
type Priority = 'critical' | 'high' | 'medium' | 'low';

type DashboardSummary = {
  customersCount: number;
  commerce: { ordersCount: number; totalSpent: string };
  openOpportunities: { total: number; byPriority: Record<Priority, number> };
  activeRecommendationsCount: number;
  integrations: { provider: string; status: string; lastSyncedAt: string | null }[];
};

const integrationStatusTone: Record<string, BadgeTone> = {
  connected: 'success',
  syncing: 'info',
  error: 'danger',
  disconnected: 'neutral',
};

const PRIORITIES: { key: Priority; label: string; bar: string; tone: BadgeTone }[] = [
  { key: 'critical', label: 'Critical', bar: 'bg-danger', tone: 'danger' },
  { key: 'high', label: 'High', bar: 'bg-warning', tone: 'warning' },
  { key: 'medium', label: 'Medium', bar: 'bg-info', tone: 'info' },
  { key: 'low', label: 'Low', bar: 'bg-muted-foreground/40', tone: 'neutral' },
];

/** Workspace-wide open opportunities by priority — each row's bar is its real share of the open total. */
function OpportunityBreakdown({ workspaceId, opportunities }: { workspaceId: string; opportunities: DashboardSummary['openOpportunities'] }) {
  if (opportunities.total === 0) {
    return (
      <EmptyState
        title="No open opportunities"
        message="Opportunities appear here once BRAYN detects them for your customers."
        action={
          <LinkButton href={`/workspace/${workspaceId}/customers`} variant="secondary" size="sm">
            Open customers
          </LinkButton>
        }
        className="py-10"
      />
    );
  }

  return (
    <ul className="space-y-3">
      {PRIORITIES.map(({ key, label, bar }) => {
        const count = opportunities.byPriority[key] ?? 0;
        const share = Math.round((count / opportunities.total) * 100);
        return (
          <li key={key} className="grid grid-cols-[88px_1fr_40px] items-center gap-3 text-[13px]">
            <span className="text-foreground/80">{label}</span>
            <span className="h-2 overflow-hidden rounded-full bg-subtle" role="img" aria-label={`${label}: ${count} of ${opportunities.total}`}>
              <span className={`block h-full rounded-full ${bar}`} style={{ width: `${share}%` }} />
            </span>
            <span className="text-right font-medium tabular-nums text-foreground">{count}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Doc 19 Phase 2 Visible Result — "See workspace state" and "manage basic workspace settings"; doc11 Merchant Dashboard. */
export default async function WorkspacePage({ params }: { params: { workspaceId: string } }) {
  let workspace: Workspace, memberships: WorkspaceSummary[], members: Membership[], currentUser: CurrentUser, dashboard: DashboardSummary;
  try {
    [workspace, memberships, members, currentUser, dashboard] = await Promise.all([
      apiFetch(`/api/v1/workspaces/${params.workspaceId}`),
      apiFetch('/api/v1/users/me/workspaces'),
      apiFetch(`/api/v1/workspaces/${params.workspaceId}/members`),
      apiFetch('/api/v1/users/me'),
      apiFetch(`/api/v1/workspaces/${params.workspaceId}/dashboard`),
    ]);
  } catch (error) {
    // Expected API failures (not a member, workspace deleted, ...) render inline rather than
    // crashing to the route error boundary — see "24. BRAYN UI UX Specification" (State Requirements).
    if (error instanceof ApiError) {
      return <ApiErrorState status={error.status} message={error.message} backHref="/" />;
    }
    throw error;
  }
  const role = memberships.find((m) => m.id === workspace.id)?.role;
  const canManage = role === 'owner' || role === 'admin';
  const { byPriority } = dashboard.openOpportunities;
  const urgent = (byPriority.critical ?? 0) + (byPriority.high ?? 0);

  return (
    <main>
      <PageHeader
        title="Dashboard"
        description={workspace.name}
        actions={
          <LinkButton href={`/workspace/${workspace.id}/customers`} variant="secondary">
            Customers <ArrowRightIcon className="h-3.5 w-3.5" />
          </LinkButton>
        }
      />

      <PageBody className="space-y-8">
        <MetricStrip>
          <Metric label="Customers" value={dashboard.customersCount} />
          <Metric label="Orders" value={dashboard.commerce.ordersCount} />
          <Metric label="Total spend" value={dashboard.commerce.totalSpent} hint="All orders, as recorded by your store" />
          <Metric
            label="Open opportunities"
            value={dashboard.openOpportunities.total}
            hint={urgent > 0 ? `${urgent} critical or high priority` : undefined}
          />
          <Metric label="Active recommendations" value={dashboard.activeRecommendationsCount} />
        </MetricStrip>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <Card className="p-5">
            <SectionHeader
              title="Revenue opportunities by priority"
              count={dashboard.openOpportunities.total > 0 ? `${dashboard.openOpportunities.total} open` : undefined}
              action={
                dashboard.openOpportunities.total > 0 && (
                  <Link href={`/workspace/${workspace.id}/customers`} className="text-[13px] font-medium text-accent hover:underline">
                    Review customers
                  </Link>
                )
              }
            />
            <div className="mt-5">
              <OpportunityBreakdown workspaceId={workspace.id} opportunities={dashboard.openOpportunities} />
            </div>
          </Card>

          <Card className="p-5">
            <SectionHeader
              title="Connected sources"
              action={
                <Link href={`/workspace/${workspace.id}/integrations`} className="text-[13px] font-medium text-accent hover:underline">
                  Manage
                </Link>
              }
            />
            {dashboard.integrations.length === 0 ? (
              <EmptyState message="No data sources connected yet." className="py-8" />
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {dashboard.integrations.map((integration) => (
                  <li key={integration.provider} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span aria-hidden className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-subtle text-xs font-semibold text-foreground/70 ring-1 ring-inset ring-border">
                        {providerLabel(integration.provider).charAt(0)}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-foreground">{providerLabel(integration.provider)}</p>
                        <p className="text-xs text-muted-foreground" title={formatDateTime(integration.lastSyncedAt)}>
                          {integration.lastSyncedAt ? `Synced ${formatRelative(integration.lastSyncedAt)}` : 'Not synced yet'}
                        </p>
                      </div>
                    </div>
                    <StatusDot tone={integrationStatusTone[integration.status] ?? 'neutral'} className="capitalize">
                      {integration.status}
                    </StatusDot>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <section className="space-y-4 border-t border-border pt-8">
          <SectionHeader title="Workspace" description="Members and settings for this workspace." />
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <Card>
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <h3 className="text-sm font-semibold text-foreground">Members</h3>
                <span className="text-[13px] tabular-nums text-muted-foreground">{members.length}</span>
              </div>
              <ul className="divide-y divide-border">
                {members.map((member) => (
                  <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="truncate font-mono text-xs text-foreground/70">{member.userId}</span>
                      {member.userId === currentUser.id && <span className="text-xs text-muted-foreground">You</span>}
                      <RoleBadge role={member.role} />
                    </div>
                    {canManage && (
                      <MemberRowActions
                        workspaceId={workspace.id}
                        userId={member.userId}
                        role={member.role}
                        isCallerOwner={role === 'owner'}
                        isSelf={member.userId === currentUser.id}
                      />
                    )}
                  </li>
                ))}
              </ul>
              {canManage && (
                <div className="border-t border-border bg-subtle/50 px-4 py-4">
                  <AddMemberForm workspaceId={workspace.id} />
                </div>
              )}
            </Card>

            <Card className="divide-y divide-border">
              {canManage && (
                <div className="px-4 py-4">
                  <RenameWorkspaceForm workspaceId={workspace.id} currentName={workspace.name} />
                </div>
              )}
              <dl className="grid grid-cols-2 gap-4 px-4 py-4 text-[13px]">
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">Workspace ID</dt>
                  <dd className="mt-1 truncate font-mono text-xs text-foreground/80">{workspace.id}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Created</dt>
                  <dd className="mt-1 text-foreground">{formatDate(workspace.createdAt)}</dd>
                </div>
              </dl>
            </Card>
          </div>
        </section>
      </PageBody>
    </main>
  );
}
