'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { retryAutomationRun } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/ui/alert';

/** Manual retry of one failed run (doc16 decision, Nov 2, 2026); the new run appears in the history after refresh. */
export function RetryRunButton({ workspaceId, automationId, runId }: { workspaceId: string; automationId: string; runId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            const outcome = await retryAutomationRun(workspaceId, automationId, runId);
            if (!outcome.ok) setError(outcome.message);
            else if (outcome.status === 'failed') setError(`Retry failed: ${outcome.reason ?? 'unknown error'}`);
            router.refresh();
          } catch {
            setError('Could not retry this run right now. Please try again.');
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Retrying…' : 'Retry'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
