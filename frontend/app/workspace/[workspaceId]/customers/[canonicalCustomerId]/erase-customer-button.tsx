'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { eraseCustomer } from '../../../../actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorText } from '@/components/ui/alert';

/** The exact phrase the backend requires — erasure is permanent. */
export const ERASURE_CONFIRMATION = 'ERASE CUSTOMER';

/** Status-specific messages. None of them include anything about the customer being erased. */
export function erasureErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return `The confirmation didn’t match. Type ${ERASURE_CONFIRMATION} exactly.`;
    case 401:
      return 'Your session has expired. Sign in again, then retry.';
    case 403:
      return 'Only the workspace owner can erase customers.';
    case 404:
      return 'This customer no longer exists — it may already have been erased.';
    case 409:
      return 'This customer is being changed right now. Wait a moment, then try again.';
    case 503:
      return 'Customer erasure isn’t available on this deployment yet. Nothing was erased.';
    default:
      return 'Could not erase this customer. Nothing was erased — try again.';
  }
}

/**
 * Owner-only "Erase customer" action (Stage 10). Opens a confirmation dialog explaining what is erased; the request
 * is only sent after the owner types the exact phrase and confirms. On success, leaves the (now deleted) customer page.
 */
export function EraseCustomerButton({ workspaceId, canonicalCustomerId }: { workspaceId: string; canonicalCustomerId: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();

  function close() {
    if (pending) return;
    setOpen(false);
    setTyped('');
    setError(null);
  }

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, pending]);

  const confirmed = typed === ERASURE_CONFIRMATION;

  async function erase() {
    if (!confirmed || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await eraseCustomer(workspaceId, canonicalCustomerId, typed);
      if (result.ok) {
        router.replace(`/workspace/${workspaceId}/customers?erased=1`);
        router.refresh();
        return;
      }
      setError(erasureErrorMessage(result.status));
    } catch {
      setError(erasureErrorMessage(0));
    }
    setPending(false);
  }

  return (
    <>
      <Button type="button" variant="danger" size="sm" onClick={() => setOpen(true)}>
        Erase customer
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4" onClick={close}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-md rounded-xl border border-border bg-surface p-5 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id={titleId} className="text-base font-semibold text-foreground">
              Erase this customer permanently?
            </h2>
            <div className="mt-2 space-y-2 text-[13px] leading-relaxed text-muted-foreground">
              <p>
                This permanently deletes this customer and everything linked to them in this workspace: their records from every
                connected store (registered and guest), their orders, website activity, memory, preferences, opportunities and
                other customer intelligence.
              </p>
              <p>Their email addresses and store IDs are blocked from being imported again.</p>
              <p className="font-medium text-danger">This cannot be undone.</p>
            </div>

            <form
              className="mt-4 space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                void erase();
              }}
            >
              <Label htmlFor={inputId}>
                Type <span className="font-mono font-semibold text-foreground">{ERASURE_CONFIRMATION}</span> to confirm
              </Label>
              <Input
                id={inputId}
                ref={inputRef}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
              />
              {error && <ErrorText>{error}</ErrorText>}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="secondary" size="sm" onClick={close} disabled={pending}>
                  Cancel
                </Button>
                <Button type="submit" variant="danger" size="sm" disabled={!confirmed || pending}>
                  {pending ? 'Erasing…' : 'Erase customer'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
