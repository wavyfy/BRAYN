import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { ApiErrorState } from '@/components/api-error-state';
import { CreateEntryForm } from './create-entry-form';

type Entry = { id: string; type: 'knowledge' | 'policy'; title: string; content: string; version: number; updatedAt: string };
type WorkspaceSummary = { id: string; name: string; role: string };

const typeStyles: Record<string, string> = {
  knowledge: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  policy: 'bg-amber-50 text-amber-700 ring-amber-600/20',
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

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link href={`/workspace/${workspaceId}`} className="text-sm text-slate-500 hover:text-slate-700">
        &larr; Workspace
      </Link>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">Knowledge &amp; Policies</h1>

      {canManage && (
        <Card className="mt-6">
          <CardContent>
            <CreateEntryForm workspaceId={workspaceId} />
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        {entries.length === 0 ? (
          <CardContent className="py-12 text-center text-sm text-slate-500">
            No knowledge or policy entries yet{canManage ? ' — add one above.' : '.'}
          </CardContent>
        ) : (
          <ul className="divide-y divide-slate-200">
            {entries.map((entry) => (
              <li key={entry.id}>
                <Link href={`/workspace/${workspaceId}/knowledge/${entry.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{entry.title}</p>
                    <p className="mt-0.5 truncate text-sm text-slate-500">{entry.content}</p>
                  </div>
                  <span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${typeStyles[entry.type]}`}>
                    {entry.type}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
