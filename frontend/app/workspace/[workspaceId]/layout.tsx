import { apiFetch, ApiError } from '@/lib/api';
import { ApiErrorState } from '@/components/api-error-state';
import { WorkspaceShell } from './workspace-shell';

type WorkspaceSummary = { id: string; name: string; role: string };

/** Shared shell for every workspace route — sidebar/top nav wraps each page's own content unchanged. */
export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { workspaceId: string };
}) {
  let memberships: WorkspaceSummary[];
  try {
    memberships = await apiFetch('/api/v1/users/me/workspaces');
  } catch (error) {
    if (error instanceof ApiError) {
      return <ApiErrorState status={error.status} message={error.message} backHref="/" />;
    }
    throw error;
  }

  return (
    <WorkspaceShell workspaceId={params.workspaceId} workspaces={memberships}>
      {children}
    </WorkspaceShell>
  );
}
