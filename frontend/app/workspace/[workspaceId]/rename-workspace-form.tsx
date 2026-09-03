'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { renameWorkspace } from '../../actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorText } from '@/components/ui/alert';

export function RenameWorkspaceForm({ workspaceId, currentName }: { workspaceId: string; currentName: string }) {
  const [name, setName] = useState(currentName);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <form
      className="flex flex-wrap items-end gap-3"
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
      <div className="min-w-0 flex-1 space-y-1.5">
        <Label htmlFor="workspace-name">Workspace name</Label>
        <Input id="workspace-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
      {error && <ErrorText className="w-full">{error}</ErrorText>}
    </form>
  );
}
