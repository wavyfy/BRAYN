'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { addMember } from '../../actions';
import { workspaceRoles } from './roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ErrorText } from '@/components/ui/alert';

export function AddMemberForm({ workspaceId }: { workspaceId: string }) {
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<(typeof workspaceRoles)[number]>('support');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <form
      className="space-y-3"
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
      <p className="text-sm font-medium text-slate-900">Add member</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="member-user-id">BRAYN user ID</Label>
          <Input
            id="member-user-id"
            type="text"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="member-role">Role</Label>
          <Select
            id="member-role"
            value={role}
            onChange={(e) => setRole(e.target.value as (typeof workspaceRoles)[number])}
          >
            {workspaceRoles.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add'}
        </Button>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </form>
  );
}
