'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { removeMember, transferOwnership, updateMemberRole } from '../../actions';
import { workspaceRoles } from './roles';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { ErrorText } from '@/components/ui/alert';

export function MemberRowActions({
  workspaceId,
  userId,
  role,
  isCallerOwner,
  isSelf,
}: {
  workspaceId: string;
  userId: string;
  role: string;
  isCallerOwner: boolean;
  isSelf: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function run(action: () => Promise<unknown>, failureMessage: string) {
    setPending(true);
    setError(null);
    try {
      await action();
      router.refresh();
    } catch {
      setError(failureMessage);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      <Select
        aria-label={`Role for ${userId}`}
        value={role}
        disabled={pending}
        onChange={(e) =>
          run(() => updateMemberRole(workspaceId, userId, e.target.value), 'Could not change this member’s role.')
        }
        className="h-8 text-xs"
      >
        {workspaceRoles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </Select>
      <Button
        type="button"
        variant="danger"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (window.confirm('Remove this member from the workspace?')) {
            run(() => removeMember(workspaceId, userId), 'Could not remove this member.');
          }
        }}
      >
        Remove
      </Button>
      {isCallerOwner && !isSelf && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pending}
          onClick={() => {
            if (window.confirm('Transfer workspace ownership to this member?')) {
              run(() => transferOwnership(workspaceId, userId), 'Could not transfer ownership.');
            }
          }}
        >
          Make owner
        </Button>
      )}
      {error && <ErrorText className="basis-full">{error}</ErrorText>}
    </div>
  );
}
