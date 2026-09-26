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
    <main className="flex min-h-[60vh] items-center justify-center px-6 py-16">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <span className="rounded-md bg-subtle px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground ring-1 ring-inset ring-border">{status}</span>
        <p className="mt-1 text-base font-semibold text-foreground">{TITLE_BY_STATUS[status] ?? 'Something went wrong'}</p>
        <p className="text-[13px] text-muted-foreground">{message}</p>
        {backHref && (
          <LinkButton href={backHref} variant="secondary" size="sm" className="mt-3">
            &larr; {backLabel}
          </LinkButton>
        )}
      </div>
    </main>
  );
}
