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

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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

  it('calls the backend directly, credentialed, with the caller\'s own bearer token, and navigates to the authorize URL', async () => {
    const { setHref, restore } = stubLocation();
    const fetchMock = vi.fn(async () => jsonResponse(201, { authorizeUrl: 'https://test-store.myshopify.com/admin/oauth/authorize?state=abc' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ShopifyConnect workspaceId="ws_1" />);
    fireEvent.change(screen.getByLabelText('Shop domain'), { target: { value: 'test-store.myshopify.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Shopify' }));

    await vi.waitFor(() => expect(setHref).toHaveBeenCalledWith('https://test-store.myshopify.com/admin/oauth/authorize?state=abc'));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/workspaces/ws_1/integrations/shopify/oauth/start');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(JSON.parse(init.body as string)).toEqual({ shopDomain: 'test-store.myshopify.com' });
    restore();
  });

  it('shows an inline error instead of navigating when the backend rejects the request', async () => {
    const { setHref, restore } = stubLocation();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, { error: { code: 'VALIDATION_ERROR', message: 'bad domain' } })));

    render(<ShopifyConnect workspaceId="ws_1" />);
    fireEvent.change(screen.getByLabelText('Shop domain'), { target: { value: 'not-a-shop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Shopify' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not start shopify authorization/i);
    expect(setHref).not.toHaveBeenCalled();
    restore();
  });
});
