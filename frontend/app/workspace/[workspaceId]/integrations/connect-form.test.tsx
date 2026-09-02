/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, connectProviderWithCredentials } = vi.hoisted(() => ({
  refresh: vi.fn(),
  connectProviderWithCredentials: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ connectProviderWithCredentials }));

import { ConnectForm } from './connect-form';

const shopifyFields = [
  { name: 'shopDomain', label: 'Shop domain' },
  { name: 'accessToken', label: 'Admin API access token', type: 'password' as const },
];

describe('ConnectForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it('renders one input per field and a Connect button', () => {
    render(<ConnectForm workspaceId="ws_1" provider="shopify" providerLabel="Shopify" fields={shopifyFields} />);

    expect(screen.getByLabelText('Shop domain')).toBeTruthy();
    expect(screen.getByLabelText('Admin API access token')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeTruthy();
  });

  it('submits entered values as the credentials payload and refreshes on success', async () => {
    connectProviderWithCredentials.mockResolvedValueOnce(undefined);
    render(<ConnectForm workspaceId="ws_1" provider="shopify" providerLabel="Shopify" fields={shopifyFields} />);

    fireEvent.change(screen.getByLabelText('Shop domain'), { target: { value: 'test-store.myshopify.com' } });
    fireEvent.change(screen.getByLabelText('Admin API access token'), { target: { value: 'shpat_abc123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await screen.findByRole('button', { name: 'Connect' });

    expect(connectProviderWithCredentials).toHaveBeenCalledWith('ws_1', 'shopify', {
      shopDomain: 'test-store.myshopify.com',
      accessToken: 'shpat_abc123',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows an inline error instead of crashing when verification fails', async () => {
    connectProviderWithCredentials.mockRejectedValueOnce(new Error('rejected'));
    render(<ConnectForm workspaceId="ws_1" provider="shopify" providerLabel="Shopify" fields={shopifyFields} />);

    fireEvent.change(screen.getByLabelText('Shop domain'), { target: { value: 'x.myshopify.com' } });
    fireEvent.change(screen.getByLabelText('Admin API access token'), { target: { value: 'bad-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not verify/i);
    expect(refresh).not.toHaveBeenCalled();
  });
});
