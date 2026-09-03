/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, startIntegrationImport, disconnectIntegration } = vi.hoisted(() => ({
  refresh: vi.fn(),
  startIntegrationImport: vi.fn(),
  disconnectIntegration: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ startIntegrationImport, disconnectIntegration }));

import { IntegrationActions } from './integration-actions';

describe('IntegrationActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(cleanup);

  it('shows last synced date and lastSyncError', () => {
    render(
      <IntegrationActions
        workspaceId="ws_1"
        provider="shopify"
        providerLabel="Shopify"
        status="error"
        lastSyncedAt="2026-01-01T00:00:00.000Z"
        lastSyncError="Could not reach Shopify."
        latestImport={null}
      />,
    );

    expect(screen.getByText('Could not reach Shopify.')).toBeTruthy();
  });

  it('renders import progress and error from the latest run', () => {
    render(
      <IntegrationActions
        workspaceId="ws_1"
        provider="shopify"
        providerLabel="Shopify"
        status="connected"
        lastSyncedAt={null}
        lastSyncError={null}
        latestImport={{
          status: 'partial',
          recordsImported: 42,
          recordsFailed: 3,
          error: 'Some records failed to normalize.',
          startedAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:05:00.000Z',
        }}
      />,
    );

    expect(screen.getByText('Import partial')).toBeTruthy();
    expect(screen.getByText('42 imported, 3 failed')).toBeTruthy();
    expect(screen.getByText('Some records failed to normalize.')).toBeTruthy();
  });

  it('starts an import and refreshes on click', async () => {
    startIntegrationImport.mockResolvedValueOnce(undefined);
    render(
      <IntegrationActions
        workspaceId="ws_1"
        provider="shopify"
        providerLabel="Shopify"
        status="connected"
        lastSyncedAt={null}
        lastSyncError={null}
        latestImport={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start import' }));
    await screen.findByRole('button', { name: 'Start import' });

    expect(startIntegrationImport).toHaveBeenCalledWith('ws_1', 'shopify');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('disables Start import while an import is already running', () => {
    render(
      <IntegrationActions
        workspaceId="ws_1"
        provider="shopify"
        providerLabel="Shopify"
        status="connected"
        lastSyncedAt={null}
        lastSyncError={null}
        latestImport={{ status: 'running', recordsImported: 1, recordsFailed: 0, error: null, startedAt: '2026-01-01T00:00:00.000Z', completedAt: null }}
      />,
    );

    expect(screen.getByRole('button', { name: 'Import running…' }).hasAttribute('disabled')).toBe(true);
  });

  it('disconnects only after the user confirms', async () => {
    disconnectIntegration.mockResolvedValueOnce(undefined);
    render(
      <IntegrationActions
        workspaceId="ws_1"
        provider="woocommerce"
        providerLabel="WooCommerce"
        status="connected"
        lastSyncedAt={null}
        lastSyncError={null}
        latestImport={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await screen.findByRole('button', { name: 'Disconnect' });

    expect(window.confirm).toHaveBeenCalled();
    expect(disconnectIntegration).toHaveBeenCalledWith('ws_1', 'woocommerce');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not disconnect when the user cancels the confirmation', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <IntegrationActions
        workspaceId="ws_1"
        provider="woocommerce"
        providerLabel="WooCommerce"
        status="connected"
        lastSyncedAt={null}
        lastSyncError={null}
        latestImport={null}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(disconnectIntegration).not.toHaveBeenCalled();
  });
});
