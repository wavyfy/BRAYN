import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { ApiErrorState } from '@/components/api-error-state';
import { PageBody, PageHeader } from '@/components/ui/page-header';
import { StatusBadge, type BadgeTone } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionHeader } from '@/components/ui/section';
import { formatDateTime, formatRelative } from '@/lib/format';
import { CreateEntryForm } from './create-entry-form';

type Entry = { id: string; type: 'knowledge' | 'policy'; title: string; content: string; version: number; updatedAt: string };
type WorkspaceSummary = { id: string; name: string; role: string };

const typeTone: Record<Entry['type'], BadgeTone> = {
  knowledge: 'info',
  policy: 'warning',
};

/** Doc19 Phase 10 — "Merchant can add business knowledge/policies and see them available to BRAYN." */
export default async function KnowledgePage({ params }: { params: { workspaceId: string } }) {
  const { workspaceId } = params;

  let entries: Entry[], memberships: WorkspaceSummary[];
  try {
    [entries, memberships] = await Promise.all([
      apiFetch(`/api/v1/workspaces/${workspaceId}/knowledge`),
      apiFetch('/api/v1/users/me/workspaces'),
    ]);
  } catch (error) {
    if (error instanceof ApiError) {
      return <ApiErrorState status={error.status} message={error.message} backHref={`/workspace/${workspaceId}`} backLabel="Back to Workspace" />;
    }
    throw error;
  }

  const role = memberships.find((m) => m.id === workspaceId)?.role;
  const canManage = role === 'owner' || role === 'admin';
  const policies = entries.filter((entry) => entry.type === 'policy').length;

  return (
    <main>
      <PageHeader title="Knowledge & Policies" description="Merchant Knowledge & Policy Store — what BRAYN's analyst knows about how your business works." />

      <PageBody>
        <div className={canManage ? 'grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_400px]' : ''}>
          <section>
            <SectionHeader
              title="Entries"
              count={entries.length > 0 ? `${entries.length - policies} knowledge · ${policies} polic${policies === 1 ? 'y' : 'ies'}` : undefined}
            />
            <div className="mt-3 overflow-hidden rounded-xl border border-border bg-surface shadow-panel">
              {entries.length === 0 ? (
                <EmptyState
                  title="Nothing here yet"
                  message={`No knowledge or policy entries yet${canManage ? ' — add one to give BRAYN context about your business.' : '.'}`}
                />
              ) : (
                <ul className="divide-y divide-border">
                  {entries.map((entry) => (
                    <li key={entry.id}>
                      <Link
                        href={`/workspace/${workspaceId}/knowledge/${entry.id}`}
                        className="flex items-start justify-between gap-4 px-4 py-3 transition-colors hover:bg-subtle/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/40"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-[13px] font-medium text-foreground">{entry.title}</p>
                            <StatusBadge tone={typeTone[entry.type]} className="shrink-0 capitalize">
                              {entry.type}
                            </StatusBadge>
                          </div>
                          <p className="mt-0.5 line-clamp-1 text-[13px] text-muted-foreground">{entry.content}</p>
                        </div>
                        <div className="shrink-0 text-right text-xs text-muted-foreground">
                          <p className="tabular-nums">v{entry.version}</p>
                          <p title={formatDateTime(entry.updatedAt)}>{formatRelative(entry.updatedAt)}</p>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {canManage && (
            <Card className="p-4">
              <SectionHeader title="New entry" description="Knowledge describes your business; policies are rules BRAYN must respect." />
              <div className="mt-4">
                <CreateEntryForm workspaceId={workspaceId} />
              </div>
            </Card>
          )}
        </div>
      </PageBody>
    </main>
  );
}
