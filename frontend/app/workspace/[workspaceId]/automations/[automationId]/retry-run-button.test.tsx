/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, retryAutomationRun } = vi.hoisted(() => ({
  refresh: vi.fn(),
  retryAutomationRun: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ retryAutomationRun }));

import { RetryRunButton } from './retry-run-button';

describe('RetryRunButton', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  const click = async () => {
    render(<RetryRunButton workspaceId="ws_1" automationId="auto_1" runId="run_1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Retry' });
  };

  it('retries the run and refreshes the history', async () => {
    retryAutomationRun.mockResolvedValueOnce({ ok: true, status: 'succeeded', reason: null });
    await click();

    expect(retryAutomationRun).toHaveBeenCalledWith('ws_1', 'auto_1', 'run_1');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/failed|Could not/)).toBeNull();
  });

  it('shows a failed retry and still refreshes so the new failed run appears', async () => {
    retryAutomationRun.mockResolvedValueOnce({ ok: true, status: 'failed', reason: 'connection reset' });
    await click();

    expect(screen.getByText('Retry failed: connection reset')).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows the refusal reason from the API', async () => {
    retryAutomationRun.mockResolvedValueOnce({ ok: false, message: 'This trigger has already been executed successfully; nothing was retried.' });
    await click();

    expect(screen.getByText('This trigger has already been executed successfully; nothing was retried.')).toBeTruthy();
  });

  it('shows a generic error and re-enables when the request itself fails', async () => {
    retryAutomationRun.mockRejectedValueOnce(new Error('network down'));
    await click();

    expect(screen.getByText('Could not retry this run right now. Please try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' }).hasAttribute('disabled')).toBe(false);
  });

  it('disables itself while retrying', async () => {
    let resolve: (value: unknown) => void = () => {};
    retryAutomationRun.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    render(<RetryRunButton workspaceId="ws_1" automationId="auto_1" runId="run_1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    const busy = await screen.findByRole('button', { name: 'Retrying…' });
    expect(busy.hasAttribute('disabled')).toBe(true);
    resolve({ ok: true, status: 'succeeded', reason: null });
    await screen.findByRole('button', { name: 'Retry' });
  });
});
