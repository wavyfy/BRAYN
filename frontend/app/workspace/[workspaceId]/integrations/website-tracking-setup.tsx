'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  connectIntegration,
  disconnectIntegration,
  generateWebsiteTrackingIdentitySecret,
  generateWebsiteTrackingWriteKey,
  setWebsiteTrackingAllowedOrigins,
} from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ErrorText } from '@/components/ui/alert';
import { env } from '@/lib/env';

export type WebsiteTrackingSettings = {
  allowedOrigins: string[];
  writeKeyConfigured: boolean;
  identitySecretConfigured: boolean;
  lastEventAt: string | null;
};

/** Not-connected state: website tracking has no credentials to enter, so connecting is one click. */
export function WebsiteTrackingConnect({ workspaceId }: { workspaceId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted-foreground">Capture page views and storefront activity with BRAYN&apos;s own tracking script — no third-party analytics app needed.</p>
      <Button
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          try {
            await connectIntegration(workspaceId, 'website_tracking');
            router.refresh();
          } catch {
            setError('Could not enable website tracking.');
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Enabling…' : 'Enable website tracking'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

/** The `<script>` tag a merchant pastes into their storefront — attributes match frontend/public/tracking.js. */
export function trackingSnippet(scriptOrigin: string, apiBase: string, workspaceId: string, writeKey: string): string {
  return `<script src="${scriptOrigin}/tracking.js" data-api-base="${apiBase}" data-workspace-id="${workspaceId}" data-write-key="${writeKey}" defer></script>`;
}

/**
 * Connected-state setup: allowed storefront origins, write key + install
 * snippet, and whether events are arriving. The write key exists in the
 * browser only right after generation (the API never returns it again), so
 * the snippet is shown once; rotating replaces it everywhere.
 */
export function WebsiteTrackingSetup({ workspaceId, settings }: { workspaceId: string; settings: WebsiteTrackingSettings }) {
  const [originsText, setOriginsText] = useState(settings.allowedOrigins.join('\n'));
  const [snippet, setSnippet] = useState<string | null>(null);
  const [identitySecret, setIdentitySecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  // While a fresh snippet is on screen the merchant is installing it — poll so "Last event received" updates without a reload.
  useEffect(() => {
    if (!snippet) return;
    const timer = setInterval(() => router.refresh(), 10_000);
    return () => clearInterval(timer);
  }, [snippet, router]);

  async function run(action: () => Promise<void>, failureMessage: string) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      router.refresh();
    } catch {
      setError(failureMessage);
    } finally {
      setPending(false);
    }
  }

  const origins = originsText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <dt className="text-muted-foreground">Last event received</dt>
          <dd className="mt-0.5 text-foreground">{settings.lastEventAt ? new Date(settings.lastEventAt).toLocaleString() : 'None yet'}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Write key</dt>
          <dd className="mt-0.5 text-foreground">{settings.writeKeyConfigured ? 'Configured' : 'Not generated'}</dd>
        </div>
      </dl>

      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const saved = await setWebsiteTrackingAllowedOrigins(workspaceId, origins);
            setOriginsText(saved.allowedOrigins.join('\n'));
            setNotice('Allowed origins saved.');
          }, 'Could not save. Each line must be an http(s) origin such as https://your-store.com.');
        }}
      >
        <Label htmlFor="website-tracking-origins">Allowed storefront origins</Label>
        <p className="text-xs text-muted-foreground">One per line, e.g. https://your-store.myshopify.com. Events from any other site are rejected.</p>
        <Textarea id="website-tracking-origins" rows={3} value={originsText} onChange={(e) => setOriginsText(e.target.value)} placeholder="https://your-store.com" />
        <Button type="submit" size="sm" variant="secondary" disabled={pending}>
          Save origins
        </Button>
      </form>

      {settings.allowedOrigins.length === 0 && <p className="text-xs text-warning">No origins allowed yet — the tracking script will be rejected until you add your storefront&apos;s origin.</p>}

      <div className="space-y-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() => {
            if (settings.writeKeyConfigured && !window.confirm('Generate a new write key? The current key stops working immediately — any installed snippet must be replaced.')) {
              return;
            }
            void run(async () => {
              const { writeKey } = await generateWebsiteTrackingWriteKey(workspaceId);
              setSnippet(trackingSnippet(window.location.origin, env.NEXT_PUBLIC_API_URL ?? '', workspaceId, writeKey));
              setCopied(false);
            }, 'Could not generate a write key.');
          }}
        >
          {settings.writeKeyConfigured ? 'Rotate write key' : 'Generate write key'}
        </Button>

        {snippet && (
          <div className="space-y-1.5 rounded-md bg-subtle px-3 py-2">
            <p className="text-xs font-medium text-foreground">Paste this before &lt;/head&gt; on every storefront page. It is shown only once.</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface p-2 text-xs text-foreground ring-1 ring-inset ring-border">{snippet}</pre>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(snippet);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy snippet'}
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Identity (optional): to link a logged-in shopper&apos;s browsing to their customer record, your <em>server</em> signs their email with the identity secret
          and the page calls <code>brayn.track(&apos;identity_signal&apos;, {'{'} email, signature {'}'})</code>. Unsigned signals never link.
        </p>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() => {
            if (settings.identitySecretConfigured && !window.confirm('Generate a new identity secret? Signatures made with the current secret stop linking immediately.')) {
              return;
            }
            void run(async () => {
              const { identitySecret: secret } = await generateWebsiteTrackingIdentitySecret(workspaceId);
              setIdentitySecret(secret);
            }, 'Could not generate an identity secret.');
          }}
        >
          {settings.identitySecretConfigured ? 'Rotate identity secret' : 'Generate identity secret'}
        </Button>

        {identitySecret && (
          <div className="space-y-1.5 rounded-md bg-subtle px-3 py-2">
            <p className="text-xs font-medium text-foreground">Store this on your server only — never in page HTML or JavaScript. It is shown only once.</p>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface p-2 text-xs text-foreground ring-1 ring-inset ring-border">{identitySecret}</pre>
            <p className="text-xs text-muted-foreground">signature = hex(HMAC-SHA256(identity secret, lowercase(trim(email))))</p>
          </div>
        )}
      </div>

      <Button
        size="sm"
        variant="danger"
        disabled={pending}
        onClick={() => {
          if (window.confirm('Disconnect website tracking? The installed script stops being accepted.')) {
            void run(() => disconnectIntegration(workspaceId, 'website_tracking'), 'Could not disconnect.');
          }
        }}
      >
        Disconnect
      </Button>

      {notice && <p role="status" className="text-sm text-success">{notice}</p>}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
