import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { CreateWorkspaceForm } from './create-workspace-form';
import { Card, CardContent } from '@/components/ui/card';
import { RoleBadge } from '@/components/ui/badge';
import { ApiErrorState } from '@/components/api-error-state';

type WorkspaceSummary = { id: string; name: string; role: string };

/** Doc 19 Phase 2 Visible Result — "Access a workspace". */
export default async function HomePage() {
  let workspaces: WorkspaceSummary[];
  try {
    workspaces = await apiFetch('/api/v1/users/me/workspaces');
  } catch (error) {
    if (error instanceof ApiError) {
      return <ApiErrorState status={error.status} message={error.message} />;
    }
    throw error;
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">BRAYN</h1>
      <p className="mt-1 text-sm text-slate-500">Your workspaces</p>

      {workspaces.length === 0 ? (
        <Card className="mt-8">
          <CardContent className="py-8">
            <p className="text-center text-sm text-slate-600">You don&apos;t belong to a workspace yet.</p>
            <div className="mx-auto mt-6 max-w-xs">
              <CreateWorkspaceForm />
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="mt-8">
          <ul className="divide-y divide-slate-200">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <Link
                  href={`/workspace/${workspace.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-900"
                >
                  <span className="text-sm font-medium text-slate-900">{workspace.name}</span>
                  <RoleBadge role={workspace.role} />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </main>
  );
}
