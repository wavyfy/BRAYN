/** @vitest-environment jsdom */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ApiError } from '@/lib/api';

const { apiFetch, refresh, approveAiActionRequest, denyAiActionRequest } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  refresh: vi.fn(),
  approveAiActionRequest: vi.fn(),
  denyAiActionRequest: vi.fn(),
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ approveAiActionRequest, denyAiActionRequest }));

import AiActionsPage from './page';

const pendingRequest = {
  id: 'req_3',
  action: 'test.high-risk-action',
  riskLevel: 'high' as const,
  permissionDecision: 'permitted' as const,
  approvalState: 'pending' as const,
  executionStatus: 'blocked_approval' as const,
  failureReason: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('AiActionsPage', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders an empty state when no AI actions have been requested yet', async () => {
    apiFetch.mockResolvedValueOnce([]);

    render(await AiActionsPage({ params: { workspaceId: 'ws_1' } }));

    expect(screen.getByText('No AI actions have been requested yet.')).toBeTruthy();
  });

  it('represents an executed low-risk action', async () => {
    apiFetch.mockResolvedValueOnce([
      {
        id: 'req_1',
        action: 'recommendation.dismiss',
        riskLevel: 'low',
        permissionDecision: 'permitted',
        approvalState: 'not_required',
        executionStatus: 'executed',
        failureReason: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    render(await AiActionsPage({ params: { workspaceId: 'ws_1' } }));

    expect(screen.getByText('recommendation dismiss')).toBeTruthy();
    expect(screen.getByText('Executed')).toBeTruthy();
    expect(screen.getByText('low risk')).toBeTruthy();
  });

  it('represents a permission-denied action, distinct from an executed one', async () => {
    apiFetch.mockResolvedValueOnce([
      {
        id: 'req_2',
        action: 'recommendation.dismiss',
        riskLevel: 'low',
        permissionDecision: 'denied',
        approvalState: 'not_required',
        executionStatus: 'blocked_permission',
        failureReason: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    render(await AiActionsPage({ params: { workspaceId: 'ws_1' } }));

    expect(screen.getByText('Blocked — permission denied')).toBeTruthy();
  });

  it('represents an approval-required (blocked) high-risk action', async () => {
    apiFetch.mockResolvedValueOnce([
      {
        id: 'req_3',
        action: 'test.high-risk-action',
        riskLevel: 'high',
        permissionDecision: 'permitted',
        approvalState: 'pending',
        executionStatus: 'blocked_approval',
        failureReason: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    render(await AiActionsPage({ params: { workspaceId: 'ws_1' } }));

    expect(screen.getByText('Blocked — approval required')).toBeTruthy();
    expect(screen.getByText('high risk')).toBeTruthy();
  });

  it('represents a failed execution with its failure reason visible', async () => {
    apiFetch.mockResolvedValueOnce([
      {
        id: 'req_4',
        action: 'recommendation.complete',
        riskLevel: 'low',
        permissionDecision: 'permitted',
        approvalState: 'not_required',
        executionStatus: 'failed',
        failureReason: 'Recommendation is already completed.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    render(await AiActionsPage({ params: { workspaceId: 'ws_1' } }));

    expect(screen.getByText('Execution failed')).toBeTruthy();
    expect(screen.getByText('Recommendation is already completed.')).toBeTruthy();
  });

  it('represents a duplicate/retried action request (doc19 Phase 14 Slice 2 — idempotency)', async () => {
    apiFetch.mockResolvedValueOnce([
      {
        id: 'req_5',
        action: 'recommendation.dismiss',
        riskLevel: 'low',
        permissionDecision: 'permitted',
        approvalState: 'not_required',
        executionStatus: 'duplicate',
        failureReason: 'This action was already requested with the same idempotency key.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    render(await AiActionsPage({ params: { workspaceId: 'ws_1' } }));

    expect(screen.getByText('Duplicate — already requested')).toBeTruthy();
    expect(screen.getByText('This action was already requested with the same idempotency key.')).toBeTruthy();
  });

  it('renders the inline access-denied state for a non-owner/admin caller (403), not a crash', async () => {
    apiFetch.mockRejectedValueOnce(new ApiError(403, 'UNAUTHORIZED', 'Your role does not permit this action.'));

    render(await AiActionsPage({ params: { workspaceId: 'ws_1' } }));

    expect(screen.getByText('Access denied')).toBeTruthy();
    expect(screen.getByText('Your role does not permit this action.')).toBeTruthy();
  });

  describe('approval-grant workflow (doc19 Phase 14)', () => {
    it('shows Approve and Deny controls for a pending request', async () => {
      apiFetch.mockResolvedValueOnce([pendingRequest]);

      render(await AiActionsPage({ params: { workspaceId: 'ws_1' } }));

      expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy();
    });

    it('does not show Approve/Deny for a non-pending request', async () => {
      apiFetch.mockResolvedValueOnce([
        {
          id: 'req_1',
          action: 'recommendation.dismiss',
          riskLevel: 'low',
          permissionDecision: 'permitted',
          approvalState: 'not_required',
          executionStatus: 'executed',
          failureReason: null,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);

      render(await AiActionsPage({ params: { workspaceId: 'ws_1' } }));

      expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull();
    });

    it('refreshes the list after a successful approve decision', async () => {
      apiFetch.mockResolvedValueOnce([pendingRequest]);
      approveAiActionRequest.mockResolvedValueOnce(undefined);
      vi.spyOn(window, 'confirm').mockReturnValue(true);

      render(await AiActionsPage({ params: { workspaceId: 'ws_1' } }));
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
      await screen.findByRole('button', { name: 'Approve' });

      expect(approveAiActionRequest).toHaveBeenCalledWith('ws_1', 'req_3');
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('shows an inline error when deny fails, without refreshing', async () => {
      apiFetch.mockResolvedValueOnce([pendingRequest]);
      denyAiActionRequest.mockRejectedValueOnce(new Error('network down'));

      render(await AiActionsPage({ params: { workspaceId: 'ws_1' } }));
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));

      expect(await screen.findByText('Could not deny right now. Please try again.')).toBeTruthy();
      expect(refresh).not.toHaveBeenCalled();
    });
  });
});
