'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { renameWorkspace } from '../../actions';

export function RenameWorkspaceForm({ workspaceId, currentName }: { workspaceId: string; currentName: string }) {
  const [name, setName] = useState(currentName);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        await renameWorkspace(workspaceId, name);
        setPending(false);
        router.refresh();
      }}
    >
      <label htmlFor="workspace-name">Rename workspace</label>
      <input id="workspace-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
      <button type="submit" disabled={pending}>
        Save
      </button>
    </form>
  );
}
