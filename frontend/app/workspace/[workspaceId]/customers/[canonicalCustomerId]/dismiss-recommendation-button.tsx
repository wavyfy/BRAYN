'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { dismissRecommendation } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/ui/alert';

export function DismissRecommendationButton({
  workspaceId,
  canonicalCustomerId,
  recommendationId,
}: {
  workspaceId: string;
  canonicalCustomerId: string;
  recommendationId: string;
}) {
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
            await dismissRecommendation(workspaceId, canonicalCustomerId, recommendationId);
            router.refresh();
          } catch {
            setError('Could not dismiss right now. Please try again.');
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Dismissing…' : 'Dismiss'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
