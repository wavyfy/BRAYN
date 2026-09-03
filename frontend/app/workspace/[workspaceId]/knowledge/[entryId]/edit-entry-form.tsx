'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { updateKnowledgeEntry } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorText } from '@/components/ui/alert';

export function EditEntryForm({
  workspaceId,
  entryId,
  currentTitle,
  currentContent,
}: {
  workspaceId: string;
  entryId: string;
  currentTitle: string;
  currentContent: string;
}) {
  const [title, setTitle] = useState(currentTitle);
  const [content, setContent] = useState(currentContent);
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
          await updateKnowledgeEntry(workspaceId, entryId, { title, content });
          router.refresh();
        } catch {
          setError('Could not save changes. Please try again.');
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="entry-title">Title</Label>
        <Input id="entry-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="entry-content">Content</Label>
        <Textarea id="entry-content" rows={6} value={content} onChange={(e) => setContent(e.target.value)} required />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save changes'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </form>
  );
}
