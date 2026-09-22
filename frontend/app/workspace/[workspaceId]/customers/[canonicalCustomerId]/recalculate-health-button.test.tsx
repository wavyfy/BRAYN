/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, recalculateCustomerHealth } = vi.hoisted(() => ({
  refresh: vi.fn(),
  recalculateCustomerHealth: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ recalculateCustomerHealth }));

import { RecalculateHealthButton } from './recalculate-health-button';

describe('RecalculateHealthButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('recalculates health, then refreshes the page', async () => {
    recalculateCustomerHealth.mockResolvedValueOnce(undefined);
    render(<RecalculateHealthButton workspaceId="ws_1" canonicalCustomerId="cust_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Calculate now' }));
    await screen.findByRole('button', { name: 'Calculate now' });

    expect(recalculateCustomerHealth).toHaveBeenCalledWith('ws_1', 'cust_1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error and re-enables the button when recalculation fails', async () => {
    recalculateCustomerHealth.mockRejectedValueOnce(new Error('network down'));
    render(<RecalculateHealthButton workspaceId="ws_1" canonicalCustomerId="cust_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Calculate now' }));
    await screen.findByText('Could not calculate right now. Please try again.');

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Calculate now' }).hasAttribute('disabled')).toBe(false);
  });
});
