import { apiFetch, ApiError } from '@/lib/api';
import { ApiErrorState } from '@/components/api-error-state';
import { PageBody, PageHeader } from '@/components/ui/page-header';
import { StatusBadge, StatusDot, type BadgeTone } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionHeader } from '@/components/ui/section';
import { ArrowRightIcon } from '@/components/ui/icons';
import { formatDateTime } from '@/lib/format';
import { ToggleAutomationButton } from './toggle-automation-button';
import { actionLabel, triggerLabel } from '../labels';

type Automation = {
  id: string;
  name: string;
  triggerType: string;
  actionType: string;
  enabled: boolean;
  conditions: { priorityIn?: string[]; typeIn?: string[] } | null;
};
type AutomationRun = { id: string; status: 'skipped' | 'succeeded' | 'failed'; reason: string | null; result: { recommendationsCount?: number } | null; createdAt: string };
type WorkspaceSummary = { id: string; name: string; role: string };

const runTone: Record<AutomationRun['status'], BadgeTone> = {
  succeeded: 'success',
  skipped: 'neutral',
  failed: 'danger',
};

function Step({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1 rounded-xl border border-border bg-surface shadow-panel px-4 py-3">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 text-[13px] font-medium text-foreground">{children}</div>
    </div>
  );
}

/** Doc19 Phase 15 UI — execution history, "from trigger to completed action." */
export default async function AutomationDetailPage({ params }: { params: { workspaceId: string; automationId: string } }) {
  const { workspaceId, automationId } = params;
  const base = `/api/v1/workspaces/${workspaceId}/automations/${automationId}`;

  let automation: Automation, runs: AutomationRun[], memberships: WorkspaceSummary[];
  try {
    [automation, runs, memberships] = await Promise.all([
      apiFetch(base),
      apiFetch(`${base}/runs`),
      apiFetch('/api/v1/users/me/workspaces'),
    ]);
  } catch (error) {
    if (error instanceof ApiError) {
      return <ApiErrorState status={error.status} message={error.message} backHref={`/workspace/${workspaceId}/automations`} backLabel="Back to Automations" />;
    }
    throw error;
  }

  const role = memberships.find((m) => m.id === workspaceId)?.role;
  const canManage = role === 'owner' || role === 'admin' || role === 'marketing';
  const priorityIn = automation.conditions?.priorityIn ?? [];
  const typeIn = automation.conditions?.typeIn ?? [];
  const hasConditions = priorityIn.length > 0 || typeIn.length > 0;

  return (
    <main>
      <PageHeader
        title={automation.name}
        backHref={`/workspace/${workspaceId}/automations`}
        backLabel="Automations"
        description={
          <StatusDot tone={automation.enabled ? 'success' : 'neutral'}>{automation.enabled ? 'Enabled' : 'Disabled'}</StatusDot>
        }
        actions={canManage && <ToggleAutomationButton workspaceId={workspaceId} automationId={automationId} enabled={automation.enabled} />}
      />

      <PageBody className="space-y-8">
        <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
          <Step label="When">{triggerLabel(automation.triggerType)}</Step>
          <ArrowRightIcon className="mx-auto h-4 w-4 shrink-0 rotate-90 text-muted-foreground md:rotate-0" />
          <Step label="Only if">
            {hasConditions ? (
              <span className="capitalize">
                {priorityIn.length > 0 && `Priority: ${priorityIn.join(', ')}`}
                {priorityIn.length > 0 && typeIn.length > 0 && ' · '}
                {typeIn.length > 0 && `Type: ${typeIn.join(', ').replace(/_/g, ' ')}`}
              </span>
            ) : (
              <span className="font-normal text-muted-foreground">No conditions — every event</span>
            )}
          </Step>
          <ArrowRightIcon className="mx-auto h-4 w-4 shrink-0 rotate-90 text-muted-foreground md:rotate-0" />
          <Step label="Then">{actionLabel(automation.actionType)}</Step>
        </div>

        <section>
          <SectionHeader title="Run history" count={runs.length > 0 ? runs.length : undefined} />
          <div className="mt-3 overflow-hidden rounded-xl border border-border bg-surface shadow-panel">
            {runs.length === 0 ? (
              <EmptyState message="No runs yet. Runs appear here each time the trigger fires." className="py-10" />
            ) : (
              <table className="w-full text-left text-[13px]">
                <thead className="border-b border-border bg-subtle text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="w-28 px-4 py-2 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-2 font-medium">
                      Detail
                    </th>
                    <th scope="col" className="w-48 px-4 py-2 text-right font-medium">
                      When
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td className="px-4 py-2.5">
                        <StatusBadge tone={runTone[run.status]} className="capitalize">
                          {run.status}
                        </StatusBadge>
                      </td>
                      <td className="px-4 py-2.5 text-foreground/80">
                        {run.reason && <span>{run.reason}</span>}
                        {run.result?.recommendationsCount !== undefined && <span>{run.result.recommendationsCount} recommendation(s) generated</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-muted-foreground">{formatDateTime(run.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </PageBody>
    </main>
  );
}
