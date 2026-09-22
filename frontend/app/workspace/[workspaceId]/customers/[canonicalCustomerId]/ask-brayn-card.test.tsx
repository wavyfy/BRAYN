/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { askMerchantBusinessAnalyst } = vi.hoisted(() => ({
  askMerchantBusinessAnalyst: vi.fn(),
}));
vi.mock('@/app/actions', () => ({ askMerchantBusinessAnalyst }));

import { AskBraynCard } from './ask-brayn-card';

describe('AskBraynCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('(2) submits the question with the correct workspaceId and customerId', async () => {
    askMerchantBusinessAnalyst.mockResolvedValueOnce({ answer: 'They ordered twice last month.' });
    render(<AskBraynCard workspaceId="ws_1" canonicalCustomerId="cust_1" />);

    fireEvent.change(screen.getByLabelText('Ask a question about this customer'), {
      target: { value: 'How engaged is this customer?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask BRAYN' }));
    await screen.findByRole('button', { name: 'Ask BRAYN' });

    expect(askMerchantBusinessAnalyst).toHaveBeenCalledWith('ws_1', 'How engaged is this customer?', 'cust_1');
  });

  it('(3) shows a loading state while awaiting the answer', async () => {
    let resolvePromise: (value: { answer: string }) => void = () => {};
    askMerchantBusinessAnalyst.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePromise = resolve;
        }),
    );
    render(<AskBraynCard workspaceId="ws_1" canonicalCustomerId="cust_1" />);

    fireEvent.change(screen.getByLabelText('Ask a question about this customer'), { target: { value: 'Any risk signals?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask BRAYN' }));

    expect(await screen.findByRole('button', { name: 'Asking…' })).toBeTruthy();

    resolvePromise({ answer: 'No major risk signals right now.' });
    await screen.findByRole('button', { name: 'Ask BRAYN' });
  });

  it('(4) renders the answer on a successful response', async () => {
    askMerchantBusinessAnalyst.mockResolvedValueOnce({ answer: 'This customer is a repeat buyer with strong recency.' });
    render(<AskBraynCard workspaceId="ws_1" canonicalCustomerId="cust_1" />);

    fireEvent.change(screen.getByLabelText('Ask a question about this customer'), { target: { value: 'Summarize this customer.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask BRAYN' }));

    expect(await screen.findByText('This customer is a repeat buyer with strong recency.')).toBeTruthy();
  });

  it('(5) shows a clear inline error and re-enables the button when the request fails', async () => {
    askMerchantBusinessAnalyst.mockRejectedValueOnce(new Error('network down'));
    render(<AskBraynCard workspaceId="ws_1" canonicalCustomerId="cust_1" />);

    fireEvent.change(screen.getByLabelText('Ask a question about this customer'), { target: { value: 'What changed recently?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask BRAYN' }));
    await screen.findByText('Could not get an answer right now. Please try again.');

    expect(screen.getByRole('button', { name: 'Ask BRAYN' }).hasAttribute('disabled')).toBe(false);
  });

  it('(6) does not submit an empty question — native required validation, same convention as existing forms', async () => {
    render(<AskBraynCard workspaceId="ws_1" canonicalCustomerId="cust_1" />);

    expect(screen.getByLabelText('Ask a question about this customer').hasAttribute('required')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Ask BRAYN' }));

    expect(askMerchantBusinessAnalyst).not.toHaveBeenCalled();
  });

  it('clears a previous answer/error when a new question is submitted', async () => {
    askMerchantBusinessAnalyst.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({ answer: 'All good here.' });
    render(<AskBraynCard workspaceId="ws_1" canonicalCustomerId="cust_1" />);
    const questionField = screen.getByLabelText('Ask a question about this customer');

    fireEvent.change(questionField, { target: { value: 'First question?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask BRAYN' }));
    await screen.findByText('Could not get an answer right now. Please try again.');

    fireEvent.change(questionField, { target: { value: 'Second question?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask BRAYN' }));
    await screen.findByText('All good here.');

    expect(screen.queryByText('Could not get an answer right now. Please try again.')).toBeNull();
  });
});
