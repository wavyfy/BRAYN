'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { setAutomationEnabled } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/ui/alert';

export function ToggleAutomationButton({ workspaceId, automationId, enabled }: { workspaceId: string; automationId: string; enabled: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            await setAutomationEnabled(workspaceId, automationId, !enabled);
            router.refresh();
          } catch {
            setError('Could not change this automation right now. Please try again.');
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Saving…' : enabled ? 'Disable' : 'Enable'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
