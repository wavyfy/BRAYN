import { apiFetch, ApiError } from '@/lib/api';
import { ApiErrorState } from '@/components/api-error-state';
import { PageBody, PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { formatDateTime } from '@/lib/format';
import { StatusBadge, type BadgeTone } from '@/components/ui/status-badge';
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

const statusTone: Record<AiActionRequest['executionStatus'], BadgeTone> = {
  executed: 'success',
  failed: 'danger',
  blocked_permission: 'warning',
  blocked_approval: 'warning',
  blocked_validation: 'neutral',
  duplicate: 'neutral',
};

const riskTone: Record<AiActionRequest['riskLevel'], BadgeTone> = {
  low: 'neutral',
  medium: 'info',
  high: 'danger',
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

  const pending = requests.filter((request) => request.approvalState === 'pending').length;

  return (
    <main>
      <PageHeader
        title="AI Actions"
        description="AI Action Control — every AI or tool-initiated action request, and how it was decided."
        actions={pending > 0 && <StatusBadge tone="warning">{pending} awaiting approval</StatusBadge>}
      />

      <PageBody>
        <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-panel">
          {requests.length === 0 ? (
            <EmptyState title="No AI actions yet" message="No AI actions have been requested yet." />
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-border bg-subtle text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Action
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Risk
                  </th>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Outcome
                  </th>
                  <th scope="col" className="hidden px-4 py-2 text-right font-medium md:table-cell">
                    Requested
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {requests.map((request) => (
                  <tr key={request.id} className="align-top">
                    <td className="px-4 py-3">
                      <span className="font-medium capitalize text-foreground">{request.action.replace(/[._]/g, ' ')}</span>
                      {request.failureReason && <p className="mt-0.5 max-w-md text-muted-foreground">{request.failureReason}</p>}
                      {request.approvalState === 'pending' && <AiActionDecisionButtons workspaceId={workspaceId} requestId={request.id} />}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge tone={riskTone[request.riskLevel]} className="capitalize">
                        {request.riskLevel} risk
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge tone={statusTone[request.executionStatus]}>{describeOutcome(request)}</StatusBadge>
                    </td>
                    <td className="hidden whitespace-nowrap px-4 py-3 text-right text-muted-foreground md:table-cell">{formatDateTime(request.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </PageBody>
    </main>
  );
}
