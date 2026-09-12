/** @vitest-environment jsdom */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ApiError } from '@/lib/api';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch };
});

import AiActionsPage from './page';

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

  it('renders the inline access-denied state for a non-owner/admin caller (403), not a crash', async () => {
    apiFetch.mockRejectedValueOnce(new ApiError(403, 'UNAUTHORIZED', 'Your role does not permit this action.'));

    render(await AiActionsPage({ params: { workspaceId: 'ws_1' } }));

    expect(screen.getByText('Access denied')).toBeTruthy();
    expect(screen.getByText('Your role does not permit this action.')).toBeTruthy();
  });
});
