import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiErrorState } from '@/components/api-error-state';
import { ToggleAutomationButton } from './toggle-automation-button';

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

const statusStyles: Record<string, string> = {
  succeeded: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  skipped: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  failed: 'bg-red-50 text-red-700 ring-red-600/20',
};

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

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link href={`/workspace/${workspaceId}/automations`} className="text-sm text-slate-500 hover:text-slate-700">
        &larr; Automations
      </Link>

      <div className="mt-2 flex items-center justify-between gap-3">
        <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-900">{automation.name}</h1>
        {canManage && <ToggleAutomationButton workspaceId={workspaceId} automationId={automationId} enabled={automation.enabled} />}
      </div>
      <p className="mt-1 text-sm capitalize text-slate-500">
        {automation.triggerType.replace('.', ' ')} → {automation.actionType.replace(/_/g, ' ')}
      </p>
      {automation.conditions && (automation.conditions.priorityIn?.length || automation.conditions.typeIn?.length) ? (
        <p className="mt-1 text-sm capitalize text-slate-500">
          {automation.conditions.priorityIn && `Priority: ${automation.conditions.priorityIn.join(', ')}`}
          {automation.conditions.priorityIn && automation.conditions.typeIn && ' · '}
          {automation.conditions.typeIn && `Type: ${automation.conditions.typeIn.join(', ').replace(/_/g, ' ')}`}
        </p>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Run history</CardTitle>
        </CardHeader>
        {runs.length === 0 ? (
          <CardContent className="py-8 text-center text-sm text-slate-500">No runs yet.</CardContent>
        ) : (
          <ul className="divide-y divide-slate-200">
            {runs.map((run) => (
              <li key={run.id} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <div className="min-w-0">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${statusStyles[run.status]}`}>
                    {run.status}
                  </span>
                  {run.reason && <p className="mt-1 truncate text-slate-600">{run.reason}</p>}
                  {run.result?.recommendationsCount !== undefined && (
                    <p className="mt-1 text-slate-600">{run.result.recommendationsCount} recommendation(s) generated</p>
                  )}
                </div>
                <span className="shrink-0 text-slate-400">{new Date(run.createdAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
