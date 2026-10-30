'use client';

import { useState } from 'react';
import { archiveCustomerPreference, createCustomerPreference, updateCustomerPreference } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/ui/alert';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { badgeShapeClassName } from '@/components/ui/status-badge';
import { cn } from '@/lib/utils';
import { formatDateTime, formatRelative } from '@/lib/format';
import { provenanceLabel, useMutation } from './customer-memory';

export type Preference = {
  id: string;
  category: string;
  content: string;
  provenance: string;
  createdAt: string;
  updatedAt: string;
};

/** Mirrors the backend categories and content limit (customer-preferences.ts, preference.schema.ts). */
const CATEGORIES = [
  { value: 'communication', label: 'Communication' },
  { value: 'product', label: 'Product' },
  { value: 'behavioural', label: 'Behavioural' },
  { value: 'interaction', label: 'Interaction' },
];
const MAX_CONTENT = 2000;

const categoryLabel = (value: string) => CATEGORIES.find((category) => category.value === value)?.label ?? value;

function CategorySelect({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <Select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      {CATEGORIES.map((category) => (
        <option key={category.value} value={category.value}>
          {category.label}
        </option>
      ))}
    </Select>
  );
}

function PreferenceItem({ workspaceId, canonicalCustomerId, preference }: { workspaceId: string; canonicalCustomerId: string; preference: Preference }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm-archive'>('view');
  const [draft, setDraft] = useState({ category: preference.category, content: preference.content });
  const { pending, error, run } = useMutation('Could not save this change. Please try again.');
  const edited = preference.updatedAt !== preference.createdAt;

  return (
    <li className="px-4 py-3">
      {mode === 'edit' ? (
        <div className="space-y-2">
          <CategorySelect label="Edit preference category" value={draft.category} onChange={(category) => setDraft({ ...draft, category })} />
          <Textarea
            aria-label="Edit preference"
            rows={2}
            maxLength={MAX_CONTENT}
            value={draft.content}
            onChange={(event) => setDraft({ ...draft, content: event.target.value })}
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setMode('view');
                setDraft({ category: preference.category, content: preference.content });
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={pending || !draft.content.trim()}
              onClick={() =>
                run(
                  () => updateCustomerPreference(workspaceId, canonicalCustomerId, preference.id, { category: draft.category, content: draft.content.trim() }),
                  () => setMode('view'),
                )
              }
            >
              {pending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-2">
            <span className={cn(badgeShapeClassName, 'shrink-0 bg-subtle text-foreground/70 ring-border')}>{categoryLabel(preference.category)}</span>
            <p className="min-w-0 whitespace-pre-wrap break-words text-sm text-foreground">{preference.content}</p>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {provenanceLabel[preference.provenance] ?? preference.provenance} ·{' '}
              <span title={formatDateTime(preference.createdAt)}>{formatRelative(preference.createdAt)}</span>
              {edited && <span title={formatDateTime(preference.updatedAt)}> · edited</span>}
            </p>
            {mode === 'confirm-archive' ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Archive this preference?</span>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setMode('view')}>
                  Cancel
                </Button>
                <Button size="sm" variant="danger" disabled={pending} onClick={() => run(() => archiveCustomerPreference(workspaceId, canonicalCustomerId, preference.id))}>
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
 * doc08 UCIR "Customer Preferences" (Slice 4.2) — known preferences the
 * merchant's team records, each in a fixed category. Merchant-provided only;
 * archived preferences are kept server-side but not shown.
 */
export function CustomerPreferences({ workspaceId, canonicalCustomerId, preferences }: { workspaceId: string; canonicalCustomerId: string; preferences: Preference[] }) {
  const [category, setCategory] = useState('communication');
  const [content, setContent] = useState('');
  const { pending, error, run } = useMutation('Could not add this preference. Please try again.');

  return (
    <div className="rounded-xl border border-border bg-surface shadow-panel">
      <form
        className="space-y-2 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!content.trim()) return;
          void run(() => createCustomerPreference(workspaceId, canonicalCustomerId, { category, content: content.trim() }), () => setContent(''));
        }}
      >
        <Textarea
          aria-label="New preference"
          rows={2}
          maxLength={MAX_CONTENT}
          placeholder="Add a known preference, e.g. prefers email over SMS…"
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
        <div className="flex items-center justify-between gap-2">
          <CategorySelect label="Preference category" value={category} onChange={setCategory} />
          <Button type="submit" size="sm" disabled={pending || !content.trim()}>
            {pending ? 'Adding…' : 'Add preference'}
          </Button>
        </div>
        {error && <ErrorText>{error}</ErrorText>}
      </form>
      {preferences.length === 0 ? (
        <p className="border-t border-border px-4 py-4 text-center text-[13px] text-muted-foreground">No preferences recorded yet.</p>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {preferences.map((preference) => (
            <PreferenceItem key={preference.id} workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} preference={preference} />
          ))}
        </ul>
      )}
    </div>
  );
}
