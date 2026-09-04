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
 * Navigates the browser directly to the backend's `/oauth/start` (a
 * top-level navigation, not a fetch) instead of calling it cross-origin
 * and then redirecting client-side. That's deliberate: the backend's
 * `/oauth/start` response sets an HttpOnly cookie that binds the OAuth
 * `state` to this browser (OAuth CSRF protection — see
 * shopify-oauth.controller.ts). A cookie set via a cross-origin `fetch`
 * (this frontend's origin calling the backend's different origin) is a
 * third-party cookie and gets silently dropped by browsers with
 * third-party-cookie blocking (Safari ITP, Firefox ETP, etc.) — a plain
 * top-level navigation to the backend's own host sets it as first-party
 * instead, which is never blocked. Since a top-level navigation can't
 * carry an `Authorization` header, the Clerk session token is passed as
 * a short-lived `?token=` query param instead — accepted only on this
 * one route (AuthGuard's `@AllowQueryToken()`), and the app's own request
 * logger already strips query strings before logging (http-logging.hook.ts).
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
          if (!token) {
            throw new Error('Not authenticated.');
          }
          const url = new URL(`${env.NEXT_PUBLIC_API_URL}/api/v1/workspaces/${workspaceId}/integrations/shopify/oauth/start`);
          url.searchParams.set('shopDomain', shopDomain);
          url.searchParams.set('token', token);
          window.location.href = url.toString();
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
