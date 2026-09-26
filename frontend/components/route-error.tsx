'use client';

import { Button } from '@/components/ui/button';
import { LinkButton } from '@/components/ui/link-button';

/**
 * Backstop for an unexpected failure on a route — pages already handle
 * expected API errors (401/403/404/409/422) inline, so only a genuine
 * bug/network failure reaches an error boundary.
 */
export function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-[60vh] items-center justify-center px-6 py-16">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <p className="text-base font-semibold text-foreground">Something went wrong</p>
        <p className="text-[13px] text-muted-foreground">{error.message || 'Please try again.'}</p>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <LinkButton href="/" variant="secondary" size="sm">
            &larr; Back to Workspaces
          </LinkButton>
        </div>
      </div>
    </main>
  );
}
