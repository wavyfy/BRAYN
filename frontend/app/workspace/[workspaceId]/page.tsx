import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { RenameWorkspaceForm } from './rename-workspace-form';
import { AddMemberForm } from './add-member-form';

type Workspace = { id: string; name: string; createdAt: string };
type WorkspaceSummary = { id: string; name: string; role: string };
type Membership = { id: string; userId: string; role: string };

/** Doc 19 Phase 2 Visible Result — "See workspace state" and "manage basic workspace settings". */
export default async function WorkspacePage({ params }: { params: { workspaceId: string } }) {
  const [workspace, memberships, members]: [Workspace, WorkspaceSummary[], Membership[]] = await Promise.all([
    apiFetch(`/api/v1/workspaces/${params.workspaceId}`),
    apiFetch('/api/v1/users/me/workspaces'),
    apiFetch(`/api/v1/workspaces/${params.workspaceId}/members`),
  ]);
  const role = memberships.find((m) => m.id === workspace.id)?.role;
  const canManage = role === 'owner' || role === 'admin';

  return (
    <main>
      <p>
        <Link href="/">&larr; Workspaces</Link>
      </p>
      <h1>{workspace.name}</h1>
      <dl>
        <dt>Workspace ID</dt>
        <dd>{workspace.id}</dd>
        <dt>Created</dt>
        <dd>{new Date(workspace.createdAt).toLocaleDateString()}</dd>
        <dt>Your role</dt>
        <dd>{role}</dd>
      </dl>
      {canManage && <RenameWorkspaceForm workspaceId={workspace.id} currentName={workspace.name} />}

      <h2>Members</h2>
      <ul>
        {members.map((member) => (
          <li key={member.id}>
            {member.userId} — {member.role}
          </li>
        ))}
      </ul>
      {canManage && <AddMemberForm workspaceId={workspace.id} />}
    </main>
  );
}
