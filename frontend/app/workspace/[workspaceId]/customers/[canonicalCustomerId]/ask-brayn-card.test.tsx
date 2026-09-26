/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { askMerchantBusinessAnalyst } = vi.hoisted(() => ({
  askMerchantBusinessAnalyst: vi.fn(),
}));
vi.mock('@/app/actions', () => ({ askMerchantBusinessAnalyst }));

import { AskBraynCard, type AskBraynContext } from './ask-brayn-card';

// Mocked API responses — these verify UI states only, not the live Merchant Business Analyst integration.
const context: AskBraynContext = { customerName: 'Maya Lindqvist', healthCalculated: true, openOpportunities: 3, activeRecommendations: 2 };
const ERROR_TEXT = 'BRAYN couldn’t answer this question right now. Your question is still in the box — try again in a moment.';

function renderCard(overrides: Partial<AskBraynContext> = {}) {
  return render(<AskBraynCard workspaceId="ws_1" canonicalCustomerId="cust_1" context={{ ...context, ...overrides }} />);
}

function ask(question: string) {
  fireEvent.change(screen.getByLabelText('Ask a question about this customer'), { target: { value: question } });
  fireEvent.click(screen.getByRole('button', { name: 'Ask BRAYN' }));
}

describe('AskBraynCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('(1) initial state names the customer, lists the context the analyst uses, and offers example questions without submitting them', () => {
    renderCard();

    expect(screen.getByText('Maya Lindqvist')).toBeTruthy();
    expect(screen.getByText('3 open revenue opportunities')).toBeTruthy();
    expect(screen.getByText('2 active recommendations')).toBeTruthy();
    expect(screen.getByText('Your Merchant Knowledge & Policy Store')).toBeTruthy();
    expect(screen.queryByText('BRAYN analysis')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Which opportunity should I act on first, and why?' }));
    expect((screen.getByLabelText('Ask a question about this customer') as HTMLTextAreaElement).value).toBe('Which opportunity should I act on first, and why?');
    expect(askMerchantBusinessAnalyst).not.toHaveBeenCalled();
  });

  it('(1b) is honest about context that is missing or failed to load', () => {
    renderCard({ healthCalculated: false, openOpportunities: null });

    expect(screen.getByText('Risk & engagement state (not calculated yet)')).toBeTruthy();
    expect(screen.getByText('open revenue opportunities (couldn’t load)')).toBeTruthy();
  });

  it('(2 + 7) submits the trimmed question with the correct workspace and customer', async () => {
    askMerchantBusinessAnalyst.mockResolvedValueOnce({ answer: 'They ordered twice last month.' });
    renderCard();

    ask('  How engaged is this customer?  ');
    await screen.findByText('They ordered twice last month.');

    expect(askMerchantBusinessAnalyst).toHaveBeenCalledWith('ws_1', 'How engaged is this customer?', 'cust_1');
  });

  it('(3 + 6) shows a non-streaming loading state and disables input and submit while processing', async () => {
    let resolvePromise: (value: { answer: string }) => void = () => {};
    askMerchantBusinessAnalyst.mockImplementation(() => new Promise((resolve) => (resolvePromise = resolve)));
    renderCard();

    ask('Any risk signals?');

    expect(await screen.findByRole('button', { name: 'Analyzing…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Analyzing…' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByLabelText('Ask a question about this customer').hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('status', { name: 'BRAYN is analyzing this customer' })).toBeTruthy();

    resolvePromise({ answer: 'No major risk signals right now.' });
    await screen.findByText('No major risk signals right now.');
    expect(screen.queryByRole('status', { name: 'BRAYN is analyzing this customer' })).toBeNull();
  });

  it('(4) separates the merchant question from the BRAYN analysis and keeps the answer’s paragraphs', async () => {
    askMerchantBusinessAnalyst.mockResolvedValueOnce({ answer: 'First point.\n\nSecond point.' });
    renderCard();

    ask('Summarize this customer.');

    expect(await screen.findByText('First point.')).toBeTruthy();
    expect(screen.getByText('Second point.')).toBeTruthy();
    expect(screen.getByText('Your question')).toBeTruthy();
    expect(screen.getByText('Summarize this customer.', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('BRAYN analysis')).toBeTruthy();
  });

  it('renders the answer’s Markdown (bold, lists) instead of literal symbols', async () => {
    askMerchantBusinessAnalyst.mockResolvedValueOnce({ answer: 'Act on **VIP recognition** first.\n\n- Critical priority\n- 12 orders' });
    renderCard();

    ask('Which opportunity first?');

    expect(await screen.findByText('VIP recognition', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText('Critical priority', { selector: 'li' })).toBeTruthy();
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it('adds no currency symbol, and notes when the analyst’s own wording uses one', async () => {
    askMerchantBusinessAnalyst.mockResolvedValueOnce({ answer: 'Estimated revenue is 28.00.' }).mockResolvedValueOnce({ answer: 'Estimated revenue is $28.00.' });
    renderCard();

    ask('Revenue?');
    expect(await screen.findByText('Estimated revenue is 28.00.')).toBeTruthy();
    expect(screen.queryByText(/doesn’t record a currency/)).toBeNull();

    ask('Revenue again?');
    expect(await screen.findByText('Estimated revenue is $28.00.')).toBeTruthy();
    expect(screen.queryByText(/\$\$/)).toBeNull();
    expect(screen.getByText(/doesn’t record a currency for these amounts yet/)).toBeTruthy();
  });

  it('(5) shows a clear error without internals, keeps the question, and re-enables submission', async () => {
    askMerchantBusinessAnalyst.mockRejectedValueOnce(new Error('OpenAI is not configured.'));
    renderCard();

    ask('What changed recently?');

    expect(await screen.findByText(ERROR_TEXT)).toBeTruthy();
    expect(screen.queryByText(/OpenAI/)).toBeNull();
    expect((screen.getByLabelText('Ask a question about this customer') as HTMLTextAreaElement).value).toBe('What changed recently?');
    expect(screen.getByRole('button', { name: 'Ask BRAYN' }).hasAttribute('disabled')).toBe(false);
  });

  it('(6b) does not submit an empty or whitespace-only question', () => {
    renderCard();

    expect(screen.getByLabelText('Ask a question about this customer').hasAttribute('required')).toBe(true);
    ask('   ');

    expect(askMerchantBusinessAnalyst).not.toHaveBeenCalled();
  });

  it('submits with Ctrl+Enter from the question box', async () => {
    askMerchantBusinessAnalyst.mockResolvedValueOnce({ answer: 'Done.' });
    renderCard();
    const field = screen.getByLabelText('Ask a question about this customer');

    fireEvent.change(field, { target: { value: 'Quick question?' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });

    expect(await screen.findByText('Done.')).toBeTruthy();
  });

  it('clears a previous error when a new question is answered', async () => {
    askMerchantBusinessAnalyst.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({ answer: 'All good here.' });
    renderCard();

    ask('First question?');
    await screen.findByText(ERROR_TEXT);
    ask('Second question?');
    await screen.findByText('All good here.');

    expect(screen.queryByText(ERROR_TEXT)).toBeNull();
  });
});
