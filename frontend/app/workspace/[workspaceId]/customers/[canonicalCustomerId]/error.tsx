'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LinkButton } from '@/components/ui/link-button';

/**
 * Backstop for an unexpected failure on this route — the page itself
 * already handles expected API errors (401/403/404/409/422) inline, so
 * only a genuine bug/network failure reaches this boundary.
 */
export default function CustomerDetailError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <p className="text-sm font-semibold text-slate-900">Something went wrong</p>
          <p className="max-w-sm text-sm text-slate-600">{error.message || 'Please try again.'}</p>
          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" onClick={() => reset()}>
              Try again
            </Button>
            <LinkButton href="/" variant="secondary" size="sm">
              &larr; Back to Workspaces
            </LinkButton>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
