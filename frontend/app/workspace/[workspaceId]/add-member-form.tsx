'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { addMember } from '../../actions';
import { workspaceRoles } from './roles';

export function AddMemberForm({ workspaceId }: { workspaceId: string }) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<(typeof workspaceRoles)[number]>('support');
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
          await addMember(workspaceId, userId, role);
          setUserId('');
          router.refresh();
        } catch {
          setError('Could not add this member. They may already belong to the workspace.');
        } finally {
          setPending(false);
        }
      }}
    >
      <label htmlFor="member-user-id">Add member (BRAYN user ID)</label>
      <input id="member-user-id" type="text" value={userId} onChange={(e) => setUserId(e.target.value)} required />
      <select value={role} onChange={(e) => setRole(e.target.value as (typeof workspaceRoles)[number])}>
        {workspaceRoles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending}>
        Add
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
