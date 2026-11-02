/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ImportantPendingActions, type InternalNotification } from './important-pending-actions';
import { actionLabel } from './automations/labels';

const notification = (overrides: Partial<InternalNotification> = {}): InternalNotification => ({
  id: 'n1',
  createdAt: new Date().toISOString(),
  opportunityId: 'o1',
  canonicalCustomerId: 'c_1',
  type: 'win_back',
  priority: 'critical',
  reason: 'No order in 150 days',
  ...overrides,
});

describe('ImportantPendingActions', () => {
  afterEach(cleanup);

  it('shows each notification’s type, priority and reason, the total, and links to the customer', () => {
    render(<ImportantPendingActions workspaceId="ws_1" notifications={{ items: [notification()], total: 14 }} />);

    expect(screen.getByText('Important pending actions')).toBeTruthy();
    expect(screen.getByText('14 total')).toBeTruthy();
    expect(screen.getByText('Win-back')).toBeTruthy();
    expect(screen.getByText('critical')).toBeTruthy();
    expect(screen.getByText('No order in 150 days')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View customer' }).getAttribute('href')).toBe('/workspace/ws_1/customers/c_1');
  });

  it('shows an empty state when there are no notifications', () => {
    render(<ImportantPendingActions workspaceId="ws_1" notifications={{ items: [], total: 0 }} />);

    expect(screen.getByText('Nothing flagged yet')).toBeTruthy();
    expect(screen.queryByText(/total/)).toBeNull();
  });

  it('shows an inline error when notifications could not be loaded', () => {
    render(<ImportantPendingActions workspaceId="ws_1" notifications={null} />);

    expect(screen.getByText(/Could not load notifications/)).toBeTruthy();
  });
});

describe('actionLabel', () => {
  it('labels both automation actions', () => {
    expect(actionLabel('generate_recommendations')).toBe('Generate recommendations');
    expect(actionLabel('internal_notification.create')).toBe('Create internal notification');
  });
});
