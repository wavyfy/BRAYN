'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { approveAiActionRequest, denyAiActionRequest } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/ui/alert';

/**
 * Doc19 Phase 14 Approval-Grant Workflow — the smallest real UI for a
 * `pending` request (doc24 AI Action UX: "Approval Required? Yes -> Approve").
 * Only rendered by the page for `approvalState === 'pending'` rows; the
 * backend re-checks owner/admin (doc28) regardless, this is UX only.
 */
export function AiActionDecisionButtons({ workspaceId, requestId }: { workspaceId: string; requestId: string }) {
  const [pending, setPending] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function decide(decision: 'approve' | 'deny') {
    setPending(decision);
    setError(null);
    try {
      if (decision === 'approve') {
        if (!window.confirm('Approve this action? It will execute immediately.')) {
          setPending(null);
          return;
        }
        await approveAiActionRequest(workspaceId, requestId);
      } else {
        await denyAiActionRequest(workspaceId, requestId);
      }
      router.refresh();
    } catch {
      setError(`Could not ${decision} right now. Please try again.`);
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="mt-2 flex flex-col items-start gap-1">
      <div className="flex gap-2">
        <Button size="sm" variant="primary" disabled={pending !== null} onClick={() => decide('approve')}>
          {pending === 'approve' ? 'Approving…' : 'Approve'}
        </Button>
        <Button size="sm" variant="danger" disabled={pending !== null} onClick={() => decide('deny')}>
          {pending === 'deny' ? 'Denying…' : 'Deny'}
        </Button>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
