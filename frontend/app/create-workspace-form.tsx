'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createWorkspace } from './actions';

export function CreateWorkspaceForm() {
  const [name, setName] = useState('');
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
          const workspace = await createWorkspace(name);
          router.push(`/workspace/${workspace.id}`);
        } catch {
          setError('Could not create the workspace. Please try again.');
          setPending(false);
        }
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
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
