/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, generateRecommendations } = vi.hoisted(() => ({
  refresh: vi.fn(),
  generateRecommendations: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ generateRecommendations }));

import { GenerateRecommendationsButton } from './generate-recommendations-button';

describe('GenerateRecommendationsButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('generates recommendations, then refreshes the page', async () => {
    generateRecommendations.mockResolvedValueOnce(undefined);
    render(<GenerateRecommendationsButton workspaceId="ws_1" canonicalCustomerId="cust_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Generate recommendations' }));
    await screen.findByRole('button', { name: 'Generate recommendations' });

    expect(generateRecommendations).toHaveBeenCalledWith('ws_1', 'cust_1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error and re-enables the button when generation fails', async () => {
    generateRecommendations.mockRejectedValueOnce(new Error('network down'));
    render(<GenerateRecommendationsButton workspaceId="ws_1" canonicalCustomerId="cust_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Generate recommendations' }));
    await screen.findByText('Could not generate recommendations right now. Please try again.');

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Generate recommendations' }).hasAttribute('disabled')).toBe(false);
  });
});
