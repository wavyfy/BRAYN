/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, approveAiActionRequest, denyAiActionRequest } = vi.hoisted(() => ({
  refresh: vi.fn(),
  approveAiActionRequest: vi.fn(),
  denyAiActionRequest: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ approveAiActionRequest, denyAiActionRequest }));

import { AiActionDecisionButtons } from './ai-action-decision-buttons';

describe('AiActionDecisionButtons', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(cleanup);

  it('approves only after the user confirms, then refreshes the list', async () => {
    approveAiActionRequest.mockResolvedValueOnce(undefined);
    render(<AiActionDecisionButtons workspaceId="ws_1" requestId="req_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('button', { name: 'Approve' });

    expect(window.confirm).toHaveBeenCalled();
    expect(approveAiActionRequest).toHaveBeenCalledWith('ws_1', 'req_1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not approve when the user cancels the confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<AiActionDecisionButtons workspaceId="ws_1" requestId="req_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(approveAiActionRequest).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('denies without a confirmation prompt, then refreshes the list', async () => {
    denyAiActionRequest.mockResolvedValueOnce(undefined);
    render(<AiActionDecisionButtons workspaceId="ws_1" requestId="req_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await screen.findByRole('button', { name: 'Deny' });

    expect(window.confirm).not.toHaveBeenCalled();
    expect(denyAiActionRequest).toHaveBeenCalledWith('ws_1', 'req_1');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error and re-enables the buttons when approve fails', async () => {
    approveAiActionRequest.mockRejectedValueOnce(new Error('network down'));
    render(<AiActionDecisionButtons workspaceId="ws_1" requestId="req_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByText('Could not approve right now. Please try again.');

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Approve' }).hasAttribute('disabled')).toBe(false);
  });
});
