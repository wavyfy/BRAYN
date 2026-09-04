/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const { getToken } = vi.hoisted(() => ({ getToken: vi.fn(async (): Promise<string | null> => 'test-token') }));
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

  it('mints a handoff token via a normal authenticated fetch, then navigates using only the opaque handoff token — never the Clerk JWT — in the URL', async () => {
    const { setHref, restore } = stubLocation();
    const fetchMock = vi.fn(async () => jsonResponse(201, { handoffToken: 'opaque-handoff-abc', expiresAt: '2026-01-01T00:00:00.000Z' }));
    vi.stubGlobal('fetch', fetchMock);

    render(<ShopifyConnect workspaceId="ws_1" />);
    fireEvent.change(screen.getByLabelText('Shop domain'), { target: { value: 'test-store.myshopify.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Shopify' }));

    await vi.waitFor(() => expect(setHref).toHaveBeenCalled());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [mintUrl, mintInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(mintUrl).toBe('http://api.test/api/v1/workspaces/ws_1/integrations/shopify/oauth/handoff-token');
    expect(mintInit.method).toBe('POST');
    expect((mintInit.headers as Record<string, string>).Authorization).toBe('Bearer test-token');

    const navUrl = new URL(setHref.mock.calls[0]?.[0] as string);
    expect(navUrl.origin + navUrl.pathname).toBe('http://api.test/api/v1/workspaces/ws_1/integrations/shopify/oauth/start');
    expect(navUrl.searchParams.get('shopDomain')).toBe('test-store.myshopify.com');
    expect(navUrl.searchParams.get('handoff')).toBe('opaque-handoff-abc');
    expect(navUrl.searchParams.get('token')).toBeNull();
    expect(navUrl.toString()).not.toContain('test-token');
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

  it('shows an inline error instead of navigating when minting the handoff token fails', async () => {
    const { setHref, restore } = stubLocation();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: { code: 'UNAUTHORIZED', message: 'not an owner/admin' } })));

    render(<ShopifyConnect workspaceId="ws_1" />);
    fireEvent.change(screen.getByLabelText('Shop domain'), { target: { value: 'test-store.myshopify.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Shopify' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not start shopify authorization/i);
    expect(setHref).not.toHaveBeenCalled();
    restore();
  });
});
