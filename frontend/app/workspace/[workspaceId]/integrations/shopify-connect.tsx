'use client';

import { useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ErrorText } from '@/components/ui/alert';
import { env } from '@/lib/env';

/**
 * OAuth connect flow (doc 20 — standalone-app authorization-code grant):
 * this only needs the shop domain to build the authorize URL — the merchant
 * approves scopes and the resulting access token stays entirely server-side
 * (ShopifyOAuthService's callback), never reaching this component.
 *
 * Calls the backend directly from the browser (`credentials: 'include'`)
 * instead of going through a Server Action. That's deliberate, not just a
 * style choice: the backend's `/oauth/start` response sets an HttpOnly
 * cookie that binds the OAuth `state` to this browser (OAuth CSRF
 * protection — see shopify-oauth.controller.ts). A Server Action's fetch
 * happens on the Next.js *server*, so any Set-Cookie it received would
 * never reach the merchant's actual browser; only a direct browser→backend
 * request can deliver that cookie to the party that needs to hold it.
 */
export function ShopifyConnect({ workspaceId }: { workspaceId: string }) {
  const { getToken } = useAuth();
  const [shopDomain, setShopDomain] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        try {
          const token = await getToken();
          const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/api/v1/workspaces/${workspaceId}/integrations/shopify/oauth/start`, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ shopDomain }),
          });
          if (!res.ok) {
            throw new Error('Could not start Shopify authorization.');
          }
          const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
          window.location.href = authorizeUrl;
        } catch {
          setError('Could not start Shopify authorization. Check the store domain and try again.');
          setPending(false);
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="shopify-shop-domain">Shop domain</Label>
        <Input
          id="shopify-shop-domain"
          type="text"
          placeholder="your-store.myshopify.com"
          value={shopDomain}
          onChange={(e) => setShopDomain(e.target.value)}
          autoComplete="off"
          required
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Redirecting to Shopify…' : 'Connect Shopify'}
      </Button>
      {error && <ErrorText>{error}</ErrorText>}
    </form>
  );
}
