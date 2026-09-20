import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiErrorState } from '@/components/api-error-state';
import { AiActionDecisionButtons } from './ai-action-decision-buttons';

type AiActionRequest = {
  id: string;
  action: string;
  riskLevel: 'low' | 'medium' | 'high';
  permissionDecision: 'permitted' | 'denied' | null;
  approvalState: 'not_required' | 'pending' | 'approved' | 'denied';
  executionStatus: 'blocked_validation' | 'blocked_permission' | 'blocked_approval' | 'duplicate' | 'executed' | 'failed';
  failureReason: string | null;
  createdAt: string;
};

const statusStyles: Record<AiActionRequest['executionStatus'], string> = {
  executed: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  failed: 'bg-red-50 text-red-700 ring-red-600/20',
  blocked_permission: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  blocked_approval: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  blocked_validation: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  duplicate: 'bg-slate-100 text-slate-700 ring-slate-500/20',
};

const riskStyles: Record<AiActionRequest['riskLevel'], string> = {
  low: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  medium: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  high: 'bg-red-50 text-red-700 ring-red-600/20',
};

function describeOutcome(request: AiActionRequest): string {
  switch (request.executionStatus) {
    case 'executed':
      return 'Executed';
    case 'failed':
      return 'Execution failed';
    case 'blocked_permission':
      return 'Blocked — permission denied';
    case 'blocked_approval':
      return 'Blocked — approval required';
    case 'blocked_validation':
      return 'Blocked — invalid input';
    case 'duplicate':
      return 'Duplicate — already requested';
  }
}

/**
 * Doc19 Phase 14 Visible Result — "Merchant can clearly see when an AI
 * action: Can execute automatically / Requires approval / Is blocked."
 * A `pending` row additionally gets Approve/Deny (doc19 Phase 14
 * Approval-Grant Workflow; doc24 AI Action UX). No registered production
 * action currently sets `requiresApproval: true` (Phase 12 Step 7's two
 * actions are both low-risk), so this list/the Approve/Deny controls are
 * expected to read empty/unused until one exists — see this slice's
 * completion report.
 */
export default async function AiActionsPage({ params }: { params: { workspaceId: string } }) {
  const { workspaceId } = params;

  let requests: AiActionRequest[];
  try {
    requests = await apiFetch(`/api/v1/workspaces/${workspaceId}/ai-actions`);
  } catch (error) {
    if (error instanceof ApiError) {
      return <ApiErrorState status={error.status} message={error.message} backHref={`/workspace/${workspaceId}`} backLabel="Back to Workspace" />;
    }
    throw error;
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link href={`/workspace/${workspaceId}`} className="text-sm text-slate-500 hover:text-slate-700">
        &larr; Workspace
      </Link>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">AI Actions</h1>
      <p className="mt-1 text-sm text-slate-500">Every AI/tool-initiated action request and how it was decided.</p>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Action history</CardTitle>
        </CardHeader>
        {requests.length === 0 ? (
          <CardContent className="py-12 text-center text-sm text-slate-500">No AI actions have been requested yet.</CardContent>
        ) : (
          <ul className="divide-y divide-slate-200">
            {requests.map((request) => (
              <li key={request.id} className="px-5 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium capitalize text-slate-900">{request.action.replace(/[._]/g, ' ')}</span>
                  <span className="shrink-0 text-xs text-slate-400">{new Date(request.createdAt).toLocaleString()}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${riskStyles[request.riskLevel]}`}>
                    {request.riskLevel} risk
                  </span>
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${statusStyles[request.executionStatus]}`}>
                    {describeOutcome(request)}
                  </span>
                </div>
                {request.failureReason && <p className="mt-1 text-slate-600">{request.failureReason}</p>}
                {request.approvalState === 'pending' && <AiActionDecisionButtons workspaceId={workspaceId} requestId={request.id} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
