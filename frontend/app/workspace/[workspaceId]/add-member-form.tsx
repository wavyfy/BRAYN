'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { addMember } from '../../actions';
import { workspaceRoles } from './roles';

export function AddMemberForm({ workspaceId }: { workspaceId: string }) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<(typeof workspaceRoles)[number]>('support');
  const [pending, setPending] = useState(false);
  const router = useRouter();

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        await addMember(workspaceId, userId, role);
        setPending(false);
        setUserId('');
        router.refresh();
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
    </form>
  );
}
