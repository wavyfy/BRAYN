import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { ApiErrorState } from '@/components/api-error-state';
import { PageBody, PageHeader } from '@/components/ui/page-header';
import { StatusDot } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionHeader } from '@/components/ui/section';
import { ArrowRightIcon, ChevronRightIcon } from '@/components/ui/icons';
import { CreateAutomationForm } from './create-automation-form';
import { actionLabel, triggerLabel } from './labels';

type Automation = { id: string; name: string; triggerType: string; actionType: string; enabled: boolean };
type WorkspaceSummary = { id: string; name: string; role: string };

/** Doc19 Phase 15 UI — "Merchant can create and observe a real automation from trigger to completed action." */
export default async function AutomationsPage({ params }: { params: { workspaceId: string } }) {
  const { workspaceId } = params;

  let automations: Automation[], memberships: WorkspaceSummary[];
  try {
    [automations, memberships] = await Promise.all([
      apiFetch(`/api/v1/workspaces/${workspaceId}/automations`),
      apiFetch('/api/v1/users/me/workspaces'),
    ]);
  } catch (error) {
    if (error instanceof ApiError) {
      return <ApiErrorState status={error.status} message={error.message} backHref={`/workspace/${workspaceId}`} backLabel="Back to Workspace" />;
    }
    throw error;
  }

  const role = memberships.find((m) => m.id === workspaceId)?.role;
  const canManage = role === 'owner' || role === 'admin' || role === 'marketing';
  const enabledCount = automations.filter((automation) => automation.enabled).length;

  return (
    <main>
      <PageHeader title="Automations" description="Business Action Automation — what BRAYN does automatically when something happens." />

      <PageBody>
        <div className={canManage ? 'grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_380px]' : ''}>
          <section>
            <SectionHeader title="All automations" count={automations.length > 0 ? `${enabledCount} of ${automations.length} enabled` : undefined} />
            <div className="mt-3 overflow-hidden rounded-xl border border-border bg-surface shadow-panel">
              {automations.length === 0 ? (
                <EmptyState title="No automations yet" message={canManage ? 'Create one to act on new opportunities or health changes automatically.' : 'No automations have been set up in this workspace.'} />
              ) : (
                <ul className="divide-y divide-border">
                  {automations.map((automation) => (
                    <li key={automation.id}>
                      <Link
                        href={`/workspace/${workspaceId}/automations/${automation.id}`}
                        className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-subtle/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/40"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium text-foreground">{automation.name}</p>
                          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <span className="text-muted-foreground/80">When</span>
                            <span className="rounded-md bg-subtle px-1.5 py-0.5 text-foreground/80 ring-1 ring-inset ring-border">{triggerLabel(automation.triggerType)}</span>
                            <ArrowRightIcon className="h-3 w-3" />
                            <span className="rounded-md bg-subtle px-1.5 py-0.5 text-foreground/80 ring-1 ring-inset ring-border">{actionLabel(automation.actionType)}</span>
                          </p>
                        </div>
                        <StatusDot tone={automation.enabled ? 'success' : 'neutral'} className="shrink-0">
                          {automation.enabled ? 'Enabled' : 'Disabled'}
                        </StatusDot>
                        <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {canManage && (
            <Card className="p-4">
              <SectionHeader title="New automation" description="Pick a trigger; BRAYN generates recommendations when it fires." />
              <div className="mt-4">
                <CreateAutomationForm workspaceId={workspaceId} />
              </div>
            </Card>
          )}
        </div>
      </PageBody>
    </main>
  );
}
