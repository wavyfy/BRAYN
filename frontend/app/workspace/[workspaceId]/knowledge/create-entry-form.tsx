'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createKnowledgeEntry } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ErrorText } from '@/components/ui/alert';

export function CreateEntryForm({ workspaceId }: { workspaceId: string }) {
  const [type, setType] = useState<'knowledge' | 'policy'>('knowledge');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
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
          await createKnowledgeEntry(workspaceId, type, title, content);
          setTitle('');
          setContent('');
          router.refresh();
        } catch {
          setError('Could not add this entry. Please try again.');
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="entry-type">Type</Label>
          <Select id="entry-type" value={type} onChange={(e) => setType(e.target.value as 'knowledge' | 'policy')}>
            <option value="knowledge">Knowledge</option>
            <option value="policy">Policy</option>
          </Select>
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="entry-title">Title</Label>
          <Input id="entry-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="entry-content">Content</Label>
        <Textarea id="entry-content" rows={4} value={content} onChange={(e) => setContent(e.target.value)} required />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Adding…' : 'Add entry'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </form>
  );
}
