'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { archiveCustomerMemory, createCustomerMemory, updateCustomerMemory } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/ui/alert';
import { Textarea } from '@/components/ui/textarea';
import { formatDateTime, formatRelative } from '@/lib/format';

export type MemoryEntry = {
  id: string;
  content: string;
  provenance: string;
  createdAt: string;
  updatedAt: string;
};

/** Mirrors the backend content limit (memory-entry.schema.ts). */
const MAX_CONTENT = 5000;

const provenanceLabel: Record<string, string> = { merchant_provided: 'Added by your team' };

/** One mutation at a time per form/entry: pending flag, inline error, then refresh the server-rendered page. */
function useMutation(errorMessage: string) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const run = async (fn: () => Promise<unknown>, onSuccess?: () => void) => {
    setPending(true);
    setError(null);
    try {
      await fn();
      onSuccess?.();
      router.refresh();
    } catch {
      setError(errorMessage);
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run };
}

function MemoryItem({ workspaceId, canonicalCustomerId, entry }: { workspaceId: string; canonicalCustomerId: string; entry: MemoryEntry }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm-archive'>('view');
  const [draft, setDraft] = useState(entry.content);
  const { pending, error, run } = useMutation('Could not save this change. Please try again.');
  const edited = entry.updatedAt !== entry.createdAt;

  return (
    <li className="px-4 py-3">
      {mode === 'edit' ? (
        <div className="space-y-2">
          <Textarea aria-label="Edit memory" rows={3} maxLength={MAX_CONTENT} value={draft} onChange={(event) => setDraft(event.target.value)} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={pending} 
              onClick={() => {
                setMode('view');
                setDraft(entry.content);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={pending || !draft.trim()}
              onClick={() => run(() => updateCustomerMemory(workspaceId, canonicalCustomerId, entry.id, draft.trim()), () => setMode('view'))}
            >
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">{entry.content}</p>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {provenanceLabel[entry.provenance] ?? entry.provenance} · <span title={formatDateTime(entry.createdAt)}>{formatRelative(entry.createdAt)}</span>
              {edited && <span title={formatDateTime(entry.updatedAt)}> · edited</span>}
            </p>
            {mode === 'confirm-archive' ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Archive this note?</span>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setMode('view')}>
                  Cancel
                </Button>
                <Button size="sm" variant="danger" disabled={pending} onClick={() => run(() => archiveCustomerMemory(workspaceId, canonicalCustomerId, entry.id))}>
                  {pending ? 'Archiving…' : 'Confirm archive'}
                </Button>
              </div>
            ) : (
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setMode('edit')}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMode('confirm-archive')}>
                  Archive
                </Button>
              </div>
            )}
          </div>
        </>
      )}
      {error && <ErrorText className="mt-1">{error}</ErrorText>}
    </li>
  );
}

/**
 * doc08 UCIR "Customer Memory" (Slice 4.1) — durable notes the merchant's
 * team adds about this customer. Merchant-provided only; archived notes are
 * kept server-side but not shown.
 */
export function CustomerMemory({ workspaceId, canonicalCustomerId, entries }: { workspaceId: string; canonicalCustomerId: string; entries: MemoryEntry[] }) {
  const [draft, setDraft] = useState('');
  const { pending, error, run } = useMutation('Could not add this note. Please try again.');

  return (
    <div className="rounded-xl border border-border bg-surface shadow-panel">
      <form
        className="space-y-2 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim()) return;
          void run(() => createCustomerMemory(workspaceId, canonicalCustomerId, draft.trim()), () => setDraft(''));
        }}
      >
        <Textarea
          aria-label="New memory"
          rows={2}
          maxLength={MAX_CONTENT}
          placeholder="Add something worth remembering about this customer…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          {error ? <ErrorText>{error}</ErrorText> : <span />}
          <Button type="submit" size="sm" disabled={pending || !draft.trim()}>
            {pending ? 'Adding…' : 'Add note'}
          </Button>
        </div>
      </form>
      {entries.length === 0 ? (
        <p className="border-t border-border px-4 py-4 text-center text-[13px] text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {entries.map((entry) => (
            <MemoryItem key={entry.id} workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}
