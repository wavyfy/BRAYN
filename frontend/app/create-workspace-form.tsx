'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createWorkspace } from './actions';

export function CreateWorkspaceForm() {
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const router = useRouter();

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        const workspace = await createWorkspace(name);
        router.push(`/workspace/${workspace.id}`);
      }}
    >
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Workspace name"
        required
      />
      <button type="submit" disabled={pending}>
        Create workspace
      </button>
    </form>
  );
}
