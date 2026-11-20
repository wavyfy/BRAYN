'use client';

import { useState, type ReactNode } from 'react';
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
 * A value the API returns exactly once (write-key snippet, identity secret). Stays on screen until the merchant
 * clicks "I've saved it" — nothing on this page refreshes it away — and only then calls `onDone`.
 */
function OneTimeSecret({ label, value, instructions, children, onDone }: { label: string; value: string; instructions: string; children?: ReactNode; onDone: () => void }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <div className="space-y-1.5 rounded-md bg-subtle px-3 py-2" role="region" aria-label={label}>
      <p className="text-xs font-medium text-foreground">{instructions}</p>
      <p className="text-xs font-medium text-warning">This can&apos;t be shown or retrieved again. Copy it and store it securely before you continue.</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface p-2 text-xs text-foreground ring-1 ring-inset ring-border">{value}</pre>
      {children}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopyState('copied');
            } catch {
              setCopyState('failed');
            }
          }}
        >
          {copyState === 'copied' ? 'Copied' : 'Copy'}
        </Button>
        <Button size="sm" onClick={onDone}>
          I&apos;ve saved it
        </Button>
      </div>
      {copyState === 'failed' && <ErrorText>Couldn&apos;t copy automatically — select the text above and copy it manually.</ErrorText>}
    </div>
  );
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
  // Set once a value was generated here, so the status and labels update without refreshing the page (which could hide it).
  const [writeKeyGenerated, setWriteKeyGenerated] = useState(false);
  const [identitySecretGenerated, setIdentitySecretGenerated] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  const writeKeyConfigured = settings.writeKeyConfigured || writeKeyGenerated;
  const identitySecretConfigured = settings.identitySecretConfigured || identitySecretGenerated;

  /** `refresh: false` for actions that reveal a one-time value — a refresh must never be what hides it. */
  async function run(action: () => Promise<void>, failureMessage: string, { refresh = true }: { refresh?: boolean } = {}) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (refresh) router.refresh();
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
          <dd className="mt-0.5 text-foreground">{writeKeyConfigured ? 'Configured' : 'Not generated'}</dd>
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
            if (writeKeyConfigured && !window.confirm('Generate a new write key? The current key stops working immediately — any installed snippet must be replaced.')) {
              return;
            }
            void run(
              async () => {
                const { writeKey } = await generateWebsiteTrackingWriteKey(workspaceId);
                setSnippet(trackingSnippet(window.location.origin, env.NEXT_PUBLIC_API_URL ?? '', workspaceId, writeKey));
                setWriteKeyGenerated(true);
              },
              'Could not generate a write key.',
              { refresh: false },
            );
          }}
        >
          {writeKeyConfigured ? 'Rotate write key' : 'Generate write key'}
        </Button>

        {snippet && (
          <OneTimeSecret
            label="New install snippet"
            value={snippet}
            instructions="Paste this before </head> on every storefront page. It contains your new write key."
            onDone={() => {
              setSnippet(null);
              router.refresh();
            }}
          />
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
            if (identitySecretConfigured && !window.confirm('Generate a new identity secret? Signatures made with the current secret stop linking immediately.')) {
              return;
            }
            void run(
              async () => {
                const { identitySecret: secret } = await generateWebsiteTrackingIdentitySecret(workspaceId);
                setIdentitySecret(secret);
                setIdentitySecretGenerated(true);
              },
              'Could not generate an identity secret.',
              { refresh: false },
            );
          }}
        >
          {identitySecretConfigured ? 'Rotate identity secret' : 'Generate identity secret'}
        </Button>

        {identitySecret && (
          <OneTimeSecret
            label="New identity secret"
            value={identitySecret}
            instructions="Store this on your server only — never in page HTML or JavaScript."
            onDone={() => {
              setIdentitySecret(null);
              router.refresh();
            }}
          >
            <p className="text-xs text-muted-foreground">signature = hex(HMAC-SHA256(identity secret, lowercase(trim(email))))</p>
          </OneTimeSecret>
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
