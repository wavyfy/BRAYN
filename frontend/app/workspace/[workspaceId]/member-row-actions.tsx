'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { removeMember, transferOwnership, updateMemberRole } from '../../actions';
import { workspaceRoles } from './roles';

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
    <span>
      <select
        value={role}
        disabled={pending}
        onChange={(e) =>
          run(
            () => updateMemberRole(workspaceId, userId, e.target.value),
            'Could not change this member’s role.',
          )
        }
      >
        {workspaceRoles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => removeMember(workspaceId, userId), 'Could not remove this member.')}
      >
        Remove
      </button>
      {isCallerOwner && !isSelf && (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => transferOwnership(workspaceId, userId), 'Could not transfer ownership.')}
        >
          Make owner
        </button>
      )}
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
