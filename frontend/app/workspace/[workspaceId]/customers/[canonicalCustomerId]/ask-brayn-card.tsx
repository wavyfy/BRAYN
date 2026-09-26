'use client';

import { useRef, useState } from 'react';
import { askMerchantBusinessAnalyst } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorText } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { AnswerMarkdown } from './answer-markdown';

/**
 * What the Merchant Business Analyst always receives for a customer-scoped
 * question (MerchantBusinessAnalystService.ask). Order/spend facts are only
 * added for owners/admins, so they're deliberately not listed here.
 */
export type AskBraynContext = {
  customerName: string;
  healthCalculated: boolean;
  /** null when that section failed to load on this page — shown as unknown, never guessed. */
  openOpportunities: number | null;
  activeRecommendations: number | null;
};

/** Static examples that only fill the question box — each maps to context the analyst is always given (opportunities, recommendations, risk & engagement). */
const EXAMPLE_QUESTIONS = [
  'Which opportunity should I act on first, and why?',
  'What is driving this customer’s risk & engagement state?',
  'What should I offer this customer next?',
];

function countLabel(count: number | null, singular: string, plural: string): string {
  if (count === null) return `${plural} (couldn’t load)`;
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * BRAYN's commerce amounts carry no currency code (a data-model limitation,
 * not decided here), so the UI never adds a symbol. If the model's own wording
 * includes one, say plainly that it isn't from BRAYN's data — the answer text
 * itself is left untouched.
 */
const CURRENCY_SYMBOL = /[$€£¥₹]/;

/**
 * doc11 Customer Intelligence View — "Request AI assistance". Customer-scoped:
 * passes the current canonicalCustomerId to the existing (unchanged) Merchant
 * Business Analyst `ask` endpoint, and renders its `{ answer }` as returned —
 * no streaming, citations or confidence are shown because the API has none.
 */
export function AskBraynCard({
  workspaceId,
  canonicalCustomerId,
  context,
}: {
  workspaceId: string;
  canonicalCustomerId: string;
  context: AskBraynContext;
}) {
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);

  const contextItems = [
    `Risk & engagement state${context.healthCalculated ? '' : ' (not calculated yet)'}`,
    countLabel(context.openOpportunities, 'open revenue opportunity', 'open revenue opportunities'),
    countLabel(context.activeRecommendations, 'active recommendation', 'active recommendations'),
    'Your Merchant Knowledge & Policy Store',
  ];

  const submit = async () => {
    const submitted = question.trim();
    if (!submitted || pending) return;
    setPending(true);
    setError(null);
    setAnswer(null);
    setAsked(submitted);
    try {
      const result = await askMerchantBusinessAnalyst(workspaceId, submitted, canonicalCustomerId);
      setAnswer(result.answer);
    } catch {
      setError('BRAYN couldn’t answer this question right now. Your question is still in the box — try again in a moment.');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-panel">
      <div className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <h2 id="ask-brayn-heading" className="text-sm font-semibold text-foreground">
            Ask BRAYN
          </h2>
          <span className="text-[13px] text-muted-foreground">Merchant Business Analyst</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1.5 text-xs">
          <span className="text-muted-foreground">Answering about</span>
          <span className="font-medium text-foreground">{context.customerName}</span>
          <span aria-hidden className="px-1 text-border-strong">|</span>
          <span className="text-muted-foreground">BRAYN draws on</span>
          <ul className="contents">
            {contextItems.map((item) => (
              <li key={item} className="rounded-md bg-subtle px-1.5 py-0.5 text-foreground/75 ring-1 ring-inset ring-border">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="px-4 py-4">
        <form
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Label htmlFor="ask-brayn-question" className="sr-only">
            Ask a question about this customer
          </Label>
          <div className="rounded-xl border border-border bg-surface shadow-[inset_0_1px_2px_rgb(28_25_23/0.05)] transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-focus/15 hover:border-border-strong">
            <Textarea
              ref={questionRef}
              id="ask-brayn-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  formRef.current?.requestSubmit();
                }
              }}
              placeholder="Ask about this customer, e.g. which opportunity should I act on first, and why?"
              rows={2}
              maxLength={2000}
              required
              disabled={pending}
              className="resize-none border-0 bg-transparent px-3.5 pt-3 text-[14px] shadow-none hover:border-0 focus-visible:ring-0"
            />
            <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
              <p className="text-xs text-muted-foreground">Ctrl/⌘ + Enter to ask</p>
              <Button type="submit" size="sm" disabled={pending}>
                {pending ? 'Analyzing…' : 'Ask BRAYN'}
              </Button>
            </div>
          </div>
        </form>

        {!asked && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-muted-foreground">Try</span>
            {EXAMPLE_QUESTIONS.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  setQuestion(example);
                  questionRef.current?.focus();
                }}
                className="cursor-pointer rounded-lg border border-border px-2.5 py-1 text-left text-xs text-foreground/75 transition-colors hover:border-border-strong hover:bg-subtle hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/40"
              >
                {example}
              </button>
            ))}
          </div>
        )}

        <div aria-live="polite">
          {asked && (
            <div className="mt-5">
              <p className="text-xs text-muted-foreground">Your question</p>
              <p className="mt-0.5 text-[13px] font-medium text-foreground">{asked}</p>

              <div className="mt-4 border-l-2 border-accent pl-4">
                <p className="text-xs font-medium text-accent">BRAYN analysis</p>
                <div className="mt-2">
                  {pending && (
                    <div role="status" aria-label="BRAYN is analyzing this customer" className="space-y-2.5">
                      <p className="text-[13px] text-muted-foreground">Analyzing {context.customerName}’s intelligence record…</p>
                      <Skeleton className="h-3.5 w-full" />
                      <Skeleton className="h-3.5 w-11/12" />
                      <Skeleton className="h-3.5 w-2/3" />
                    </div>
                  )}
                  {error && <ErrorText>{error}</ErrorText>}
                  {answer && (
                    <>
                      <AnswerMarkdown source={answer} />
                      {CURRENCY_SYMBOL.test(answer) && (
                        <p className="mt-3 text-xs text-muted-foreground">
                          BRAYN doesn’t record a currency for these amounts yet — any currency symbol above is the analyst’s wording.
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
