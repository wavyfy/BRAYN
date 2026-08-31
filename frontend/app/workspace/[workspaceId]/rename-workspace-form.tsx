'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { renameWorkspace } from '../../actions';

export function RenameWorkspaceForm({ workspaceId, currentName }: { workspaceId: string; currentName: string }) {
  const [name, setName] = useState(currentName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        try {
          await renameWorkspace(workspaceId, name);
          router.refresh();
        } catch {
          setError('Could not rename the workspace. Please try again.');
        } finally {
          setPending(false);
        }
      }}
    >
      <label htmlFor="workspace-name">Rename workspace</label>
      <input id="workspace-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
      <button type="submit" disabled={pending}>
        Save
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
