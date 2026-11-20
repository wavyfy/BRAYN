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

describe('WebsiteTrackingSetup — one-time values stay until saved (regression)', () => {
  const writeText = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    writeText.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const cases = [
    {
      name: 'identity secret',
      generate: generateWebsiteTrackingIdentitySecret,
      result: { identitySecret: 'secret_once' },
      shown: 'secret_once',
      before: 'Generate identity secret',
      after: 'Rotate identity secret',
      configured: { identitySecretConfigured: true },
      region: 'New identity secret',
    },
    {
      name: 'write key snippet',
      generate: generateWebsiteTrackingWriteKey,
      result: { writeKey: 'fresh_key' },
      shown: /data-write-key="fresh_key"/,
      before: 'Generate write key',
      after: 'Rotate write key',
      configured: { writeKeyConfigured: true },
      region: 'New install snippet',
    },
  ] as const;

  for (const c of cases) {
    it(`${c.name}: no automatic refresh; status updates locally; survives a re-render with fresh settings; Copy; hidden only by "I've saved it"`, async () => {
      vi.mocked(c.generate).mockResolvedValue(c.result as never);
      const { rerender } = render(<WebsiteTrackingSetup workspaceId="ws_1" settings={unconfigured} />);

      fireEvent.click(screen.getByRole('button', { name: c.before }));
      await waitFor(() => expect(screen.getByText(c.shown)).toBeTruthy());

      expect(refresh).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: c.after })).toBeTruthy();
      const region = screen.getByRole('region', { name: c.region });
      expect(region.textContent).toContain("can't be shown or retrieved again");

      // What a later refresh would deliver: the server now reports it configured. The value must still be on screen.
      rerender(<WebsiteTrackingSetup workspaceId="ws_1" settings={{ ...unconfigured, ...c.configured }} />);
      expect(screen.getByText(c.shown)).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy());
      expect(writeText).toHaveBeenCalledWith(screen.getByRole('region', { name: c.region }).querySelector('pre')!.textContent);

      fireEvent.click(screen.getByRole('button', { name: "I've saved it" }));
      expect(screen.queryByText(c.shown)).toBeNull();
      expect(refresh).toHaveBeenCalledTimes(1);
    });
  }

  it('nothing refreshes the page on a timer while a value is on screen', async () => {
    generateWebsiteTrackingWriteKey.mockResolvedValue({ writeKey: 'fresh_key' });
    render(<WebsiteTrackingSetup workspaceId="ws_1" settings={unconfigured} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate write key' }));
    await waitFor(() => expect(screen.getByText(/data-write-key="fresh_key"/)).toBeTruthy());

    vi.useFakeTimers();
    vi.advanceTimersByTime(60_000);

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByText(/data-write-key="fresh_key"/)).toBeTruthy();
  });

  it('a failed copy keeps the value on screen and says to copy it manually', async () => {
    generateWebsiteTrackingIdentitySecret.mockResolvedValue({ identitySecret: 'secret_once' });
    writeText.mockRejectedValue(new Error('denied'));
    render(<WebsiteTrackingSetup workspaceId="ws_1" settings={unconfigured} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate identity secret' }));
    await waitFor(() => expect(screen.getByText('secret_once')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('copy it manually'));
    expect(screen.getByText('secret_once')).toBeTruthy();
  });

  it('a failed generation shows an error and no value', async () => {
    generateWebsiteTrackingIdentitySecret.mockRejectedValue(new Error('500'));
    render(<WebsiteTrackingSetup workspaceId="ws_1" settings={unconfigured} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate identity secret' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not generate an identity secret.'));
    expect(screen.queryByRole('region', { name: 'New identity secret' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate identity secret' })).toBeTruthy();
  });

  it('saving origins still refreshes (only one-time values skip it)', async () => {
    setWebsiteTrackingAllowedOrigins.mockResolvedValue({ allowedOrigins: ['https://a.example'] });
    render(<WebsiteTrackingSetup workspaceId="ws_1" settings={unconfigured} />);
    fireEvent.change(screen.getByLabelText('Allowed storefront origins'), { target: { value: 'https://a.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save origins' }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});
