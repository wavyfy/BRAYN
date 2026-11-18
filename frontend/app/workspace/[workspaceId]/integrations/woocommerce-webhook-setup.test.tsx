/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { refresh, generateWooCommerceWebhookSecret } = vi.hoisted(() => ({
  refresh: vi.fn(),
  generateWooCommerceWebhookSecret: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/app/actions', () => ({ generateWooCommerceWebhookSecret }));

import { WooCommerceWebhookSetup, type WooCommerceWebhookSettings } from './woocommerce-webhook-setup';

const settings = (secretConfigured: boolean): WooCommerceWebhookSettings => ({
  webhookUrl: 'https://api.example.com/api/v1/workspaces/ws_1/integrations/woocommerce/webhooks',
  topics: ['customer.created', 'order.updated'],
  secretConfigured,
});

describe('WooCommerceWebhookSetup', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows the delivery URL, topics and that nothing is set up yet', () => {
    render(<WooCommerceWebhookSetup workspaceId="ws_1" settings={settings(false)} />);

    expect(screen.getByText(settings(false).webhookUrl)).toBeTruthy();
    expect(screen.getByText('customer.created, order.updated')).toBeTruthy();
    expect(screen.getByText('Not set up')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate webhook secret' })).toBeTruthy();
  });

  it('generates a secret, shows it once with a copy button, and refreshes', async () => {
    generateWooCommerceWebhookSecret.mockResolvedValueOnce({ webhookSecret: 'whsec_abc' });
    render(<WooCommerceWebhookSetup workspaceId="ws_1" settings={settings(false)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Generate webhook secret' }));

    expect(await screen.findByText('whsec_abc')).toBeTruthy();
    expect(generateWooCommerceWebhookSecret).toHaveBeenCalledWith('ws_1');
    expect(screen.getByRole('button', { name: 'Copy secret' })).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('asks before rotating an existing secret, and does nothing when cancelled', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    render(<WooCommerceWebhookSetup workspaceId="ws_1" settings={settings(true)} />);

    expect(screen.getByText('Secret configured')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate webhook secret' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('current secret stops working immediately'));
    expect(generateWooCommerceWebhookSecret).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('shows an error when generation fails', async () => {
    generateWooCommerceWebhookSecret.mockRejectedValueOnce(new Error('409'));
    render(<WooCommerceWebhookSetup workspaceId="ws_1" settings={settings(false)} />);

    fireEvent.click(screen.getByRole('button', { name: 'Generate webhook secret' }));

    expect(await screen.findByText('Could not generate a webhook secret.')).toBeTruthy();
    expect(screen.queryByText('whsec_abc')).toBeNull();
  });
});
