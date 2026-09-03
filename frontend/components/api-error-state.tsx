import { Card, CardContent } from '@/components/ui/card';
import { LinkButton } from '@/components/ui/link-button';

const TITLE_BY_STATUS: Partial<Record<number, string>> = {
  401: 'Session expired',
  403: 'Access denied',
  404: 'Not found',
  409: 'Conflict',
  422: 'Invalid request',
};

/**
 * Renders an expected API failure (doc 24 — "Errors must provide
 * actionable information"; doc 18 — safe error exposure) as page content
 * rather than a thrown error. `message` is always the backend's own
 * vetted, user-facing text — see ApiError in lib/api.ts.
 */
export function ApiErrorState({
  status,
  message,
  backHref,
  backLabel = 'Back to Workspaces',
}: {
  status: number;
  message: string;
  backHref?: string;
  backLabel?: string;
}) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <p className="text-sm font-semibold text-slate-900">{TITLE_BY_STATUS[status] ?? 'Something went wrong'}</p>
          <p className="max-w-sm text-sm text-slate-600">{message}</p>
          {backHref && (
            <LinkButton href={backHref} variant="secondary" size="sm" className="mt-4">
              &larr; {backLabel}
            </LinkButton>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
