'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createWorkspace } from './actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorText } from '@/components/ui/alert';

export function CreateWorkspaceForm() {
  const [name, setName] = useState('');
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
          const workspace = await createWorkspace(name);
          router.push(`/workspace/${workspace.id}`);
        } catch {
          setError('Could not create the workspace. Please try again.');
          setPending(false);
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="workspace-name">Workspace name</Label>
        <Input
          id="workspace-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Inc."
          required
        />
      </div>
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Creating…' : 'Create workspace'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </form>
  );
}
