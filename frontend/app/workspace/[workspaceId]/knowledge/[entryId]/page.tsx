import { apiFetch, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { ApiErrorState } from '@/components/api-error-state';
import { PageBody, PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { SectionHeader } from '@/components/ui/section';
import { formatDateTime } from '@/lib/format';
import { EditEntryForm } from './edit-entry-form';

type Entry = { id: string; type: 'knowledge' | 'policy'; title: string; content: string; version: number };
type HistoryEntry = { version: number; title: string; content: string; changedAt: string };
type WorkspaceSummary = { id: string; name: string; role: string };

/** Doc19 Phase 10 — versioning verification: editing shows the resulting version history. */
export default async function KnowledgeEntryPage({ params }: { params: { workspaceId: string; entryId: string } }) {
  const { workspaceId, entryId } = params;
  const base = `/api/v1/workspaces/${workspaceId}/knowledge/${entryId}`;

  let entry: Entry, history: HistoryEntry[], memberships: WorkspaceSummary[];
  try {
    [entry, history, memberships] = await Promise.all([
      apiFetch(base),
      apiFetch(`${base}/history`),
      apiFetch('/api/v1/users/me/workspaces'),
    ]);
  } catch (error) {
    if (error instanceof ApiError) {
      return <ApiErrorState status={error.status} message={error.message} backHref={`/workspace/${workspaceId}/knowledge`} backLabel="Back to Knowledge" />;
    }
    throw error;
  }

  const role = memberships.find((m) => m.id === workspaceId)?.role;
  const canManage = role === 'owner' || role === 'admin';

  return (
    <main>
      <PageHeader
        title={entry.title}
        backHref={`/workspace/${workspaceId}/knowledge`}
        backLabel="Knowledge & Policies"
        description={
          <span className="inline-flex items-center gap-2">
            <StatusBadge tone={entry.type === 'policy' ? 'warning' : 'info'} className="capitalize">
              {entry.type}
            </StatusBadge>
            <span className="tabular-nums">Version {entry.version}</span>
          </span>
        }
      />

      <PageBody>
        <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <Card className="p-4">
            <SectionHeader title={canManage ? 'Edit' : 'Content'} />
            <div className="mt-4">
              {canManage ? (
                <EditEntryForm workspaceId={workspaceId} entryId={entryId} currentTitle={entry.title} currentContent={entry.content} />
              ) : (
                <p className="max-w-[72ch] whitespace-pre-wrap text-[14px] leading-relaxed text-foreground">{entry.content}</p>
              )}
            </div>
          </Card>

          <section>
            <SectionHeader title="Version history" count={history.length} />
            <ol className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-panel">
              {history.map((h) => (
                <li key={h.version} className="px-4 py-2.5 text-[13px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium tabular-nums text-foreground">v{h.version}</span>
                    <span className="text-xs text-muted-foreground">{formatDateTime(h.changedAt)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-muted-foreground">{h.title}</p>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </PageBody>
    </main>
  );
}
