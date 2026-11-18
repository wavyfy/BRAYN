'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { generateWooCommerceWebhookSecret } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { ErrorText } from '@/components/ui/alert';

export type WooCommerceWebhookSettings = {
  webhookUrl: string;
  topics: string[];
  secretConfigured: boolean;
};

/**
 * Manual WooCommerce webhook setup (read-only API keys are enough). The secret exists in the browser only right after
 * generation — the API never returns it again — so it is shown once; regenerating rotates it, and the merchant must
 * paste the new one into every WooCommerce webhook.
 */
export function WooCommerceWebhookSetup({ workspaceId, settings }: { workspaceId: string; settings: WooCommerceWebhookSettings }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-medium text-foreground">Real-time updates (webhooks)</h3>
        <span className="text-xs text-muted-foreground">{settings.secretConfigured ? 'Secret configured' : 'Not set up'}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        In WooCommerce → Settings → Advanced → Webhooks, add one webhook per topic below: status Active, API version WP REST API Integration v3, this delivery
        URL, and the secret from BRAYN.
      </p>
      <dl className="space-y-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Delivery URL</dt>
          <dd className="mt-0.5 break-all font-mono text-foreground">{settings.webhookUrl}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Topics</dt>
          <dd className="mt-0.5 font-mono text-foreground">{settings.topics.join(', ')}</dd>
        </div>
      </dl>

      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={async () => {
          if (settings.secretConfigured && !window.confirm('Generate a new webhook secret? The current secret stops working immediately — update it in every WooCommerce webhook.')) {
            return;
          }
          setPending(true);
          setError(null);
          try {
            const result = await generateWooCommerceWebhookSecret(workspaceId);
            setSecret(result.webhookSecret);
            setCopied(false);
            router.refresh();
          } catch {
            setError('Could not generate a webhook secret.');
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? 'Generating…' : settings.secretConfigured ? 'Rotate webhook secret' : 'Generate webhook secret'}
      </Button>

      {secret && (
        <div className="space-y-1.5 rounded-md bg-subtle px-3 py-2">
          <p className="text-xs font-medium text-foreground">Paste this as the Secret of each WooCommerce webhook. It is shown only once.</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface p-2 text-xs text-foreground ring-1 ring-inset ring-border">{secret}</pre>
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              await navigator.clipboard.writeText(secret);
              setCopied(true);
            }}
          >
            {copied ? 'Copied' : 'Copy secret'}
          </Button>
        </div>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
