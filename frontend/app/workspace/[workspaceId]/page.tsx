import Link from 'next/link';
import { apiFetch } from '@/lib/api';

type Workspace = { id: string; name: string; createdAt: string };

/** Doc 19 Phase 2 Visible Result — "See workspace state". */
export default async function WorkspacePage({ params }: { params: { workspaceId: string } }) {
  const workspace: Workspace = await apiFetch(`/api/v1/workspaces/${params.workspaceId}`);

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
      </dl>
    </main>
  );
}
