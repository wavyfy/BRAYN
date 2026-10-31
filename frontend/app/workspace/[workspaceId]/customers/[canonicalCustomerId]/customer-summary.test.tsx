/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, generateCustomerSummary } = vi.hoisted(() => ({ refresh: vi.fn(), generateCustomerSummary: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ generateCustomerSummary }));

import { RefreshSummaryButton } from './customer-summary';

describe('RefreshSummaryButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('generates for this customer, then refreshes the page', async () => {
    generateCustomerSummary.mockResolvedValueOnce({});
    render(<RefreshSummaryButton workspaceId="ws_1" canonicalCustomerId="cust_1" hasSummary />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(screen.getByRole('button', { name: 'Generating…' })).toBeTruthy();
    await screen.findByRole('button', { name: 'Refresh' });

    expect(generateCustomerSummary).toHaveBeenCalledWith('ws_1', 'cust_1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error and does not refresh when generation fails', async () => {
    generateCustomerSummary.mockRejectedValueOnce(new Error('down'));
    render(<RefreshSummaryButton workspaceId="ws_1" canonicalCustomerId="cust_1" hasSummary={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('Could not generate a summary right now. Please try again.');
    expect(refresh).not.toHaveBeenCalled();
  });
});
