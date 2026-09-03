'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { generateRecommendations } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/ui/alert';

export function GenerateRecommendationsButton({ workspaceId, canonicalCustomerId }: { workspaceId: string; canonicalCustomerId: string }) {
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
            await generateRecommendations(workspaceId, canonicalCustomerId);
            router.refresh();
          } catch {
            setError('Could not generate recommendations right now. Please try again.');
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Generating…' : 'Generate recommendations'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
