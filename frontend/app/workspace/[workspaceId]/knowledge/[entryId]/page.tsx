import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiErrorState } from '@/components/api-error-state';
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
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link href={`/workspace/${workspaceId}/knowledge`} className="text-sm text-slate-500 hover:text-slate-700">
        &larr; Knowledge &amp; Policies
      </Link>

      <div className="mt-2 flex items-center justify-between gap-3">
        <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-900">{entry.title}</h1>
        <span className="shrink-0 text-sm capitalize text-slate-500">{entry.type} · v{entry.version}</span>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{canManage ? 'Edit' : 'Content'}</CardTitle>
        </CardHeader>
        <CardContent>
          {canManage ? (
            <EditEntryForm workspaceId={workspaceId} entryId={entryId} currentTitle={entry.title} currentContent={entry.content} />
          ) : (
            <p className="whitespace-pre-wrap text-sm text-slate-900">{entry.content}</p>
          )}
        </CardContent>
      </Card>

      {history.length > 1 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Version history</CardTitle>
          </CardHeader>
          <ul className="divide-y divide-slate-200">
            {history.map((h) => (
              <li key={h.version} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <span className="text-slate-600">
                  v{h.version} · {h.title}
                </span>
                <span className="text-slate-400">{new Date(h.changedAt).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}
