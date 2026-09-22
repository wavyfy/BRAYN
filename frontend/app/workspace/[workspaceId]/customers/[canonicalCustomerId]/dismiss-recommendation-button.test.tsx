/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, dismissRecommendation } = vi.hoisted(() => ({
  refresh: vi.fn(),
  dismissRecommendation: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ dismissRecommendation }));

import { DismissRecommendationButton } from './dismiss-recommendation-button';

describe('DismissRecommendationButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('dismisses the recommendation, then refreshes the page', async () => {
    dismissRecommendation.mockResolvedValueOnce(undefined);
    render(<DismissRecommendationButton workspaceId="ws_1" canonicalCustomerId="cust_1" recommendationId="rec_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await screen.findByRole('button', { name: 'Dismiss' });

    expect(dismissRecommendation).toHaveBeenCalledWith('ws_1', 'cust_1', 'rec_1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error and re-enables the button when dismissal fails', async () => {
    dismissRecommendation.mockRejectedValueOnce(new Error('network down'));
    render(<DismissRecommendationButton workspaceId="ws_1" canonicalCustomerId="cust_1" recommendationId="rec_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await screen.findByText('Could not dismiss right now. Please try again.');

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Dismiss' }).hasAttribute('disabled')).toBe(false);
  });
});
