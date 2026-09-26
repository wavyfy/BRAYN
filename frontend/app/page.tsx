import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { apiFetch, ApiError } from '@/lib/api';
import { CreateWorkspaceForm } from './create-workspace-form';
import { RoleBadge } from '@/components/ui/badge';
import { ApiErrorState } from '@/components/api-error-state';
import { ChevronRightIcon } from '@/components/ui/icons';

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
    <main className="flex min-h-screen flex-col">
      <div className="flex items-center justify-between px-6 py-4">
        <span className="flex items-center gap-2">
          <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-primary text-[12px] font-bold text-primary-foreground">
            B
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-foreground">BRAYN</span>
        </span>
        <UserButton />
      </div>

      <div className="mx-auto w-full max-w-md flex-1 px-6 pb-16 pt-[12vh]">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{workspaces.length === 0 ? 'Create your workspace' : 'Choose a workspace'}</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {workspaces.length === 0 ? "You don't belong to a workspace yet." : 'Your workspaces'}
        </p>

        {workspaces.length === 0 ? (
          <div className="mt-6 rounded-xl border border-border bg-surface shadow-panel p-5">
            <CreateWorkspaceForm />
          </div>
        ) : (
          <ul className="mt-6 divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-panel">
            {workspaces.map((workspace) => (
              <li key={workspace.id}>
                <Link
                  href={`/workspace/${workspace.id}`}
                  className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-subtle/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/40"
                >
                  <span aria-hidden className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-subtle text-xs font-semibold text-foreground/70 ring-1 ring-inset ring-border">
                    {workspace.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{workspace.name}</span>
                  <RoleBadge role={workspace.role} />
                  <ChevronRightIcon className="h-4 w-4 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
