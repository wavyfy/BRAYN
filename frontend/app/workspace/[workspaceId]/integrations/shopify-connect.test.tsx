/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { getToken } = vi.hoisted(() => ({ getToken: vi.fn(async () => 'test-token') }));
vi.mock('@clerk/nextjs', () => ({ useAuth: () => ({ getToken }) }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_API_URL: 'http://api.test' } }));

import { ShopifyConnect } from './shopify-connect';

function stubLocation() {
  const setHref = vi.fn();
  const original = window.location;
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...original, set href(url: string) { setHref(url); } },
  });
  return { setHref, restore: () => Object.defineProperty(window, 'location', { configurable: true, value: original }) };
}

describe('ShopifyConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getToken.mockResolvedValue('test-token');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders a shop domain input and a Connect Shopify button', () => {
    render(<ShopifyConnect workspaceId="ws_1" />);

    expect(screen.getByLabelText('Shop domain')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect Shopify' })).toBeTruthy();
  });

  it('navigates the browser directly to the backend start endpoint with shopDomain and the caller\'s token as query params, without a fetch round-trip', async () => {
    const { setHref, restore } = stubLocation();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<ShopifyConnect workspaceId="ws_1" />);
    fireEvent.change(screen.getByLabelText('Shop domain'), { target: { value: 'test-store.myshopify.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Shopify' }));

    await vi.waitFor(() => expect(setHref).toHaveBeenCalled());

    expect(fetchMock).not.toHaveBeenCalled();
    const url = new URL(setHref.mock.calls[0][0] as string);
    expect(url.origin + url.pathname).toBe('http://api.test/api/v1/workspaces/ws_1/integrations/shopify/oauth/start');
    expect(url.searchParams.get('shopDomain')).toBe('test-store.myshopify.com');
    expect(url.searchParams.get('token')).toBe('test-token');
    restore();
  });

  it('shows an inline error instead of navigating when no Clerk token is available', async () => {
    const { setHref, restore } = stubLocation();
    getToken.mockResolvedValueOnce(null);

    render(<ShopifyConnect workspaceId="ws_1" />);
    fireEvent.change(screen.getByLabelText('Shop domain'), { target: { value: 'test-store.myshopify.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Shopify' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not start shopify authorization/i);
    expect(setHref).not.toHaveBeenCalled();
    restore();
  });
});
