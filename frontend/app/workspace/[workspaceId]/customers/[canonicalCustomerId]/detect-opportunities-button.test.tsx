/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, detectRevenueOpportunities } = vi.hoisted(() => ({
  refresh: vi.fn(),
  detectRevenueOpportunities: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ detectRevenueOpportunities }));

import { DetectOpportunitiesButton } from './detect-opportunities-button';

describe('DetectOpportunitiesButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('runs detection, then refreshes the page', async () => {
    detectRevenueOpportunities.mockResolvedValueOnce(undefined);
    render(<DetectOpportunitiesButton workspaceId="ws_1" canonicalCustomerId="cust_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Detect opportunities' }));
    await screen.findByRole('button', { name: 'Detect opportunities' });

    expect(detectRevenueOpportunities).toHaveBeenCalledWith('ws_1', 'cust_1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error and re-enables the button when detection fails', async () => {
    detectRevenueOpportunities.mockRejectedValueOnce(new Error('network down'));
    render(<DetectOpportunitiesButton workspaceId="ws_1" canonicalCustomerId="cust_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Detect opportunities' }));
    await screen.findByText('Could not run detection right now. Please try again.');

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Detect opportunities' }).hasAttribute('disabled')).toBe(false);
  });
});
