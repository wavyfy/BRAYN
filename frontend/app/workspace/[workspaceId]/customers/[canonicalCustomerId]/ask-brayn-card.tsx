'use client';

import { useState } from 'react';
import { askMerchantBusinessAnalyst } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorText } from '@/components/ui/alert';

/** doc11 Customer Intelligence View — "Request AI assistance" action, customer-scoped: passes the current canonicalCustomerId to the existing (unchanged) Merchant Business Analyst `ask` endpoint. */
export function AskBraynCard({ workspaceId, canonicalCustomerId }: { workspaceId: string; canonicalCustomerId: string }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        setAnswer(null);
        try {
          const result = await askMerchantBusinessAnalyst(workspaceId, question, canonicalCustomerId);
          setAnswer(result.answer);
        } catch {
          setError('Could not get an answer right now. Please try again.');
        } finally {
          setPending(false);
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="ask-brayn-question">Ask a question about this customer</Label>
        <Textarea
          id="ask-brayn-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. Why is this customer's health score low?"
          rows={3}
          required
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Asking…' : 'Ask BRAYN'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
      {answer && <p className="rounded-md bg-slate-50 p-3 text-sm text-slate-900">{answer}</p>}
    </form>
  );
}
