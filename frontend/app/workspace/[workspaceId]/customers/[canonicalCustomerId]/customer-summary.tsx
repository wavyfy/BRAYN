'use client';

import { generateCustomerSummary } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/ui/alert';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useMutation } from './customer-memory';

export type CustomerSummaryView = {
  summary: { content: string; provenance: string; model: string; generatedAt: string; generatedByUserId: string } | null;
  stale: boolean;
};

/** Header action: generate the first summary, or refresh an existing one (one AI call, manual only). */
export function RefreshSummaryButton({ workspaceId, canonicalCustomerId, hasSummary }: { workspaceId: string; canonicalCustomerId: string; hasSummary: boolean }) {
  const { pending, error, run } = useMutation('Could not generate a summary right now. Please try again.');

  return (
    <div className="flex flex-col items-end gap-2">
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => generateCustomerSummary(workspaceId, canonicalCustomerId))}>
        {pending ? 'Generating…' : hasSummary ? 'Refresh' : 'Generate'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

/**
 * doc08 UCIR "Customer Summary" (Slice 4.5) — AI-generated, saved, and
 * refreshed only on request. Always labelled as AI output that may be
 * outdated; `stale` means the customer's data changed since it was made.
 */
export function CustomerSummary({ view }: { view: CustomerSummaryView }) {
  if (!view.summary) {
    return <p className="px-4 py-4 text-center text-[13px] text-muted-foreground">No summary yet. Generate one from this customer&apos;s current data.</p>;
  }
  const { content, generatedAt } = view.summary;

  return (
    <div className="space-y-2 p-4">
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{content}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          AI-generated · may be outdated · <span title={formatDateTime(generatedAt)}>{formatRelative(generatedAt)}</span>
        </span>
        {view.stale && (
          <StatusBadge tone="warning" dot>
            Data changed since this summary
          </StatusBadge>
        )}
      </div>
    </div>
  );
}
