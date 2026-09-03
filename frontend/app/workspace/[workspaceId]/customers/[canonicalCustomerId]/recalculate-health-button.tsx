'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { recalculateCustomerHealth } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/ui/alert';

export function RecalculateHealthButton({ workspaceId, canonicalCustomerId }: { workspaceId: string; canonicalCustomerId: string }) {
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
            await recalculateCustomerHealth(workspaceId, canonicalCustomerId);
            router.refresh();
          } catch {
            setError('Could not calculate right now. Please try again.');
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Calculating…' : 'Calculate now'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
