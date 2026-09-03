import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { ApiErrorState } from '@/components/api-error-state';
import { CreateAutomationForm } from './create-automation-form';

type Automation = { id: string; name: string; triggerType: string; actionType: string; enabled: boolean };
type WorkspaceSummary = { id: string; name: string; role: string };

function describe(automation: Automation): string {
  return `${automation.triggerType.replace('.', ' ')} → ${automation.actionType.replace(/_/g, ' ')}`;
}

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

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link href={`/workspace/${workspaceId}`} className="text-sm text-slate-500 hover:text-slate-700">
        &larr; Workspace
      </Link>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">Automations</h1>

      {canManage && (
        <Card className="mt-6">
          <CardContent>
            <CreateAutomationForm workspaceId={workspaceId} />
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        {automations.length === 0 ? (
          <CardContent className="py-12 text-center text-sm text-slate-500">
            No automations yet{canManage ? ' — add one above.' : '.'}
          </CardContent>
        ) : (
          <ul className="divide-y divide-slate-200">
            {automations.map((automation) => (
              <li key={automation.id}>
                <Link href={`/workspace/${workspaceId}/automations/${automation.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{automation.name}</p>
                    <p className="mt-0.5 truncate text-sm capitalize text-slate-500">{describe(automation)}</p>
                  </div>
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
                      automation.enabled ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' : 'bg-slate-100 text-slate-700 ring-slate-500/20'
                    }`}
                  >
                    {automation.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
