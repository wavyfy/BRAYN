/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { refresh, connectIntegration, disconnectIntegration, generateWebsiteTrackingIdentitySecret, generateWebsiteTrackingWriteKey, setWebsiteTrackingAllowedOrigins } = vi.hoisted(() => ({
  generateWebsiteTrackingIdentitySecret: vi.fn(),
  refresh: vi.fn(),
  connectIntegration: vi.fn(),
  disconnectIntegration: vi.fn(),
  generateWebsiteTrackingWriteKey: vi.fn(),
  setWebsiteTrackingAllowedOrigins: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/app/actions", () => ({ connectIntegration, disconnectIntegration, generateWebsiteTrackingIdentitySecret, generateWebsiteTrackingWriteKey, setWebsiteTrackingAllowedOrigins }));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_API_URL: 'https://api.brayn.test' } }));

import { WebsiteTrackingConnect, WebsiteTrackingSetup, trackingSnippet, type WebsiteTrackingSettings } from './website-tracking-setup';

const unconfigured: WebsiteTrackingSettings = { allowedOrigins: [], writeKeyConfigured: false, identitySecretConfigured: false, lastEventAt: null };

describe('trackingSnippet', () => {
  it('builds the script tag tracking.js expects', () => {
    expect(trackingSnippet('https://app.brayn.test', 'https://api.brayn.test', 'ws_1', 'key_1')).toBe(
      '<script src="https://app.brayn.test/tracking.js" data-api-base="https://api.brayn.test" data-workspace-id="ws_1" data-write-key="key_1" defer></script>',
    );
  });
});

describe('WebsiteTrackingConnect', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('connects the website_tracking provider with one click', async () => {
    connectIntegration.mockResolvedValue({});
    render(<WebsiteTrackingConnect workspaceId="ws_1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Enable website tracking' }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(connectIntegration).toHaveBeenCalledWith('ws_1', 'website_tracking');
  });
});

describe('WebsiteTrackingSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(cleanup);

  it('shows the unconfigured state and warns that no origin is allowed yet', () => {
    render(<WebsiteTrackingSetup workspaceId="ws_1" settings={unconfigured} />);

    expect(screen.getByText('None yet')).toBeTruthy();
    expect(screen.getByText('Not generated')).toBeTruthy();
    expect(screen.getByText(/No origins allowed yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate write key' })).toBeTruthy();
  });

  it('saves one origin per line, ignoring blank lines', async () => {
    setWebsiteTrackingAllowedOrigins.mockResolvedValue({ allowedOrigins: ['https://a.example', 'https://b.example'] });
    render(<WebsiteTrackingSetup workspaceId="ws_1" settings={unconfigured} />);

    fireEvent.change(screen.getByLabelText('Allowed storefront origins'), { target: { value: ' https://a.example \n\nhttps://b.example\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save origins' }));

    await waitFor(() => expect(screen.getByText('Allowed origins saved.')).toBeTruthy());
    expect(setWebsiteTrackingAllowedOrigins).toHaveBeenCalledWith('ws_1', ['https://a.example', 'https://b.example']);
  });

  it('shows the backend validation failure for a bad origin', async () => {
    setWebsiteTrackingAllowedOrigins.mockRejectedValue(new Error('400'));
    render(<WebsiteTrackingSetup workspaceId="ws_1" settings={unconfigured} />);

    fireEvent.change(screen.getByLabelText('Allowed storefront origins'), { target: { value: 'not a url' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save origins' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('http(s) origin'));
  });

  it('generates a write key and shows the install snippet once', async () => {
    generateWebsiteTrackingWriteKey.mockResolvedValue({ writeKey: 'fresh_key' });
    render(<WebsiteTrackingSetup workspaceId="ws_1" settings={unconfigured} />);

    fireEvent.click(screen.getByRole('button', { name: 'Generate write key' }));

    await waitFor(() => expect(screen.getByText(/data-write-key="fresh_key"/)).toBeTruthy());
    expect(screen.getByText(/data-api-base="https:\/\/api.brayn.test"/)).toBeTruthy();
    expect(screen.getByText(/data-workspace-id="ws_1"/)).toBeTruthy();
    // No confirmation needed when there is no key to break yet.
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('asks before rotating an existing key, and does nothing if declined', () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<WebsiteTrackingSetup workspaceId="ws_1" settings={{ ...unconfigured, writeKeyConfigured: true }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rotate write key' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(generateWebsiteTrackingWriteKey).not.toHaveBeenCalled();
  });

  it('generates an identity secret and shows it once with server-side signing guidance', async () => {
    generateWebsiteTrackingIdentitySecret.mockResolvedValue({ identitySecret: 'secret_once' });
    render(<WebsiteTrackingSetup workspaceId="ws_1" settings={unconfigured} />);

    fireEvent.click(screen.getByRole('button', { name: 'Generate identity secret' }));

    await waitFor(() => expect(screen.getByText('secret_once')).toBeTruthy());
    expect(screen.getByText(/never in page HTML or JavaScript/)).toBeTruthy();
  });

  it('shows the last event time once events arrive', () => {
    render(<WebsiteTrackingSetup workspaceId="ws_1" settings={{ ...unconfigured, lastEventAt: '2026-10-22T17:04:35.068Z' }} />);

    expect(screen.queryByText('None yet')).toBeNull();
  });
});
