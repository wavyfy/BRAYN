/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@clerk/nextjs', () => ({ useAuth: () => ({ getToken: vi.fn() }) }));

import IntegrationsPage from './page';

afterEach(cleanup);
beforeEach(() => apiFetch.mockReset());

function renderPage(
  integrations: unknown[],
  role = 'owner',
  searchParams: Record<string, string> = {},
) {
  apiFetch.mockImplementation(async (...args: unknown[]) => {
    const path = String(args[0]);
    if (path.endsWith('/integrations')) return integrations;
    if (path === '/api/v1/users/me/workspaces') return [{ id: 'ws_1', role }];
    if (path.endsWith('/import')) return null;
    if (path.endsWith('/webhook-setup'))
      return { webhookUrl: 'https://api/x', topics: [], secretConfigured: false };
    if (path.endsWith('/website-tracking/settings'))
      return { writeKeyConfigured: false, allowedOrigins: [], identitySecretConfigured: false };
    return null;
  });
  return IntegrationsPage({
    params: Promise.resolve({ workspaceId: 'ws_1' }),
    searchParams: Promise.resolve(searchParams),
  });
}

describe('IntegrationsPage — onboarding v1 launch readiness', () => {
  it('offers the Shopify connect path, shows WooCommerce as coming soon with no connect form, and the checkout provider as optional', async () => {
    render(await renderPage([]));

    expect(screen.getByText('Commerce platform')).toBeTruthy();
    expect(screen.getByPlaceholderText(/myshopify\.com/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText('ck_…')).toBeNull();
    expect(screen.queryByPlaceholderText('https://your-store.com')).toBeNull();
    expect(screen.getAllByText('Coming soon')).toHaveLength(2);
    expect(screen.getByText(/WooCommerce support is being verified/)).toBeTruthy();
    expect(screen.getByText(/Optional — not needed to use BRAYN/)).toBeTruthy();
  });

  it('explains a store held by another workspace without naming that workspace', async () => {
    render(await renderPage([], 'owner', { shopify: 'error', reason: 'owned_elsewhere' }));

    expect(screen.getByRole('alert').textContent).toBe(
      'This Shopify store is already connected to another BRAYN workspace. Disconnect it there first, or contact support to move it.',
    );
  });

  it('keeps an existing WooCommerce connection manageable, labelled not yet verified', async () => {
    render(
      await renderPage([
        {
          id: 'i_w',
          provider: 'woocommerce',
          status: 'connected',
          lastSyncedAt: null,
          lastSyncError: null,
        },
      ]),
    );

    expect(screen.getByText(/Not yet verified with a real store/)).toBeTruthy();
    expect(screen.getAllByText('Coming soon')).toHaveLength(1); // only the checkout provider card
  });
});
