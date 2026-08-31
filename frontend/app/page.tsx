import Link from 'next/link';
import { apiFetch } from '@/lib/api';
import { CreateWorkspaceForm } from './create-workspace-form';

type WorkspaceSummary = { id: string; name: string; role: string };

/** Doc 19 Phase 2 Visible Result — "Access a workspace". */
export default async function HomePage() {
  const workspaces: WorkspaceSummary[] = await apiFetch('/api/v1/users/me/workspaces');

  if (workspaces.length === 0) {
    return (
      <main>
        <h1>BRAYN</h1>
        <p>You don&apos;t belong to a workspace yet.</p>
        <CreateWorkspaceForm />
      </main>
    );
  }

  return (
    <main>
      <h1>BRAYN</h1>
      <ul>
        {workspaces.map((workspace) => (
          <li key={workspace.id}>
            <Link href={`/workspace/${workspace.id}`}>{workspace.name}</Link> — {workspace.role}
          </li>
        ))}
      </ul>
    </main>
  );
}
