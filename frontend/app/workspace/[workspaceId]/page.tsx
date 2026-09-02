import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { RenameWorkspaceForm } from './rename-workspace-form';
import { AddMemberForm } from './add-member-form';
import { MemberRowActions } from './member-row-actions';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RoleBadge } from '@/components/ui/badge';
import { ApiErrorState } from '@/components/api-error-state';

type Workspace = { id: string; name: string; createdAt: string };
type WorkspaceSummary = { id: string; name: string; role: string };
type Membership = { id: string; userId: string; role: string };
type CurrentUser = { id: string };

/** Doc 19 Phase 2 Visible Result — "See workspace state" and "manage basic workspace settings". */
export default async function WorkspacePage({ params }: { params: { workspaceId: string } }) {
  let workspace: Workspace, memberships: WorkspaceSummary[], members: Membership[], currentUser: CurrentUser;
  try {
    [workspace, memberships, members, currentUser] = await Promise.all([
      apiFetch(`/api/v1/workspaces/${params.workspaceId}`),
      apiFetch('/api/v1/users/me/workspaces'),
      apiFetch(`/api/v1/workspaces/${params.workspaceId}/members`),
      apiFetch('/api/v1/users/me'),
    ]);
  } catch (error) {
    // Expected API failures (not a member, workspace deleted, ...) render inline rather than
    // crashing to the route error boundary — see "24. BRAYN UI UX Specification" (State Requirements).
    if (error instanceof ApiError) {
      return <ApiErrorState status={error.status} message={error.message} backHref="/" />;
    }
    throw error;
  }
  const role = memberships.find((m) => m.id === workspace.id)?.role;
  const canManage = role === 'owner' || role === 'admin';

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link href="/" className="text-sm text-slate-500 hover:text-slate-700">
        &larr; Workspaces
      </Link>

      <div className="mt-2 flex items-center justify-between gap-3">
        <h1 className="truncate text-2xl font-semibold tracking-tight text-slate-900">{workspace.name}</h1>
        {role && <RoleBadge role={role} />}
      </div>

      <nav className="mt-4 flex gap-4 text-sm">
        <Link href={`/workspace/${workspace.id}/customers`} className="font-medium text-slate-600 hover:text-slate-900">
          Customers
        </Link>
        <Link href={`/workspace/${workspace.id}/integrations`} className="font-medium text-slate-600 hover:text-slate-900">
          Integrations
        </Link>
      </nav>

      <Card className="mt-6">
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-slate-500">Workspace ID</dt>
              <dd className="mt-0.5 truncate font-mono text-xs text-slate-700">{workspace.id}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Created</dt>
              <dd className="mt-0.5 text-slate-900">{new Date(workspace.createdAt).toLocaleDateString()}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {canManage && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Workspace settings</CardTitle>
          </CardHeader>
          <CardContent>
            <RenameWorkspaceForm workspaceId={workspace.id} currentName={workspace.name} />
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <ul className="divide-y divide-slate-200">
          {members.map((member) => (
            <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="truncate font-mono text-xs text-slate-600">{member.userId}</span>
                <RoleBadge role={member.role} />
              </div>
              {canManage && (
                <MemberRowActions
                  workspaceId={workspace.id}
                  userId={member.userId}
                  role={member.role}
                  isCallerOwner={role === 'owner'}
                  isSelf={member.userId === currentUser.id}
                />
              )}
            </li>
          ))}
        </ul>
        {canManage && (
          <CardContent className="border-t border-slate-200">
            <AddMemberForm workspaceId={workspace.id} />
          </CardContent>
        )}
      </Card>
    </main>
  );
}
