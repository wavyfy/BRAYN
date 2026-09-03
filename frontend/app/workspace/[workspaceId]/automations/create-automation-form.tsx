'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createAutomation } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorText } from '@/components/ui/alert';

export function CreateAutomationForm({ workspaceId }: { workspaceId: string }) {
  const [name, setName] = useState('');
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
          await createAutomation(workspaceId, name);
          setName('');
          router.refresh();
        } catch {
          setError('Could not create this automation. Please try again.');
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <Label htmlFor="automation-name">Name</Label>
        <Input
          id="automation-name"
          type="text"
          placeholder="e.g. Recommend on new opportunity"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Adding…' : 'Add automation'}
      </Button>
      {error && <ErrorText className="w-full">{error}</ErrorText>}
    </form>
  );
}
