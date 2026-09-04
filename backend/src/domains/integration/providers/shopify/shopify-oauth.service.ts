import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConflictError, ProviderError, ValidationError } from '../../../../common/errors/app-error';
import {
  decryptCredential,
  encryptCredential,
  InvalidEncryptionKeyError,
  parseEncryptionKey,
} from '../../../../common/crypto/credential-cipher';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import { IntegrationService } from '../../integration.service';
import {
  requestShopifyClientCredentialsToken,
  SHOPIFY_CLIENT_CREDENTIALS_GRANT_TYPE,
  SHOPIFY_DOMAIN_PATTERN,
  ShopifyAdapter,
} from './shopify.adapter';
import type { Env } from '../../../../config/env.schema';

/** Exactly what ShopifyAdapter's fetchCustomers/fetchProducts/fetchOrders read (doc 20 — request only what's used). */
const SHOPIFY_OAUTH_SCOPES = ['read_customers', 'read_orders', 'read_products'].join(',');

/** `state` round-trips through the merchant's browser and Shopify — 10 minutes is generous for a consent screen, tight enough to bound replay. */
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const STATE_COOKIE_MAX_AGE_SECONDS = 600;

/**
 * Binds `state` to the browser that started the flow (OWASP OAuth CSRF —
 * without this, a state minted for the attacker's own workspace can be
 * dropped into a *different* shop's authorize URL and handed to a victim
 * merchant; the victim's approval would still decrypt to the attacker's
 * workspaceId, silently attaching the victim's Shopify store to the
 * attacker's BRAYN account). `boundSecret` never leaves this service
 * unencrypted except inside the cookie itself, and the cookie is
 * HttpOnly/Secure/SameSite=Lax so only the browser holding it — not a link
 * recipient — can complete the callback that its value was issued for.
 */
export const STATE_COOKIE_NAME = 'brayn_shopify_oauth_state';

interface OAuthState {
  workspaceId: string;
  nonce: string;
  issuedAt: number;
  boundSecret: string;
}

export interface AuthorizeUrlResult {
  authorizeUrl: string;
  cookieValue: string;
  cookieMaxAgeSeconds: number;
}

/**
 * Percent-decodes a raw query string the way Shopify's HMAC signing
 * expects — `%2B` → `+`, but a literal, unencoded `+` stays `+` (not a
 * space). Fastify's default `@Query()` parser follows
 * application/x-www-form-urlencoded rules instead (`+` → space), which
 * silently corrupts any callback value that legitimately contains a raw
 * `+` — most notably `host`, which is base64 and can contain `+` as a
 * normal alphabet character. That corruption happens *before* the
 * controller ever sees the value, so `verifyHmac` must work from the raw
 * query string, not the already-parsed `@Query()` object, to compute the
 * same message Shopify signed. Throws on malformed percent-encoding
 * (`decodeURIComponent`'s own `URIError`) — callers must treat that as a
 * verification failure, not let it crash the request.
 */
export function decodeShopifyCallbackQuery(rawQuery: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!rawQuery) {
    return result;
  }
  for (const pair of rawQuery.split('&')) {
    if (!pair) continue;
    const eqIndex = pair.indexOf('=');
    const rawKey = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
    const rawValue = eqIndex === -1 ? '' : pair.slice(eqIndex + 1);
    result[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
  }
  return result;
}

/**
 * Standalone-app OAuth authorization-code grant (shopify.dev — apps that
 * run outside the Shopify admin; BRAYN is never embedded). Two hops:
 * `buildAuthorizeUrl` (authenticated — the merchant is already in a BRAYN
 * session) starts it, `handleCallback` (Shopify → merchant's browser, no
 * BRAYN session) finishes it. `state` carries the workspace across that
 * gap — see its own doc comment for why encryption instead of a DB table.
 *
 * Ends by writing through the *same* IntegrationService.connect()/
 * setCredentials() the manual flow always used — this file has no
 * separate credential path, satisfying "one credential system."
 */
@Injectable()
export class ShopifyOAuthService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly integrationService: IntegrationService,
    private readonly shopifyAdapter: ShopifyAdapter,
    private readonly logger: StructuredLoggerService,
  ) {}

  buildAuthorizeUrl(workspaceId: string, shopDomain: string): AuthorizeUrlResult {
    if (!SHOPIFY_DOMAIN_PATTERN.test(shopDomain)) {
      throw new ValidationError('Enter a valid Shopify store domain (e.g. your-store.myshopify.com).');
    }

    const clientId = this.config.get('SHOPIFY_APP_CLIENT_ID', { infer: true });
    if (!clientId) {
      // Fail closed rather than building a URL Shopify will reject anyway — see resolveEncryptionKey's sibling in integration.service.ts.
      throw new ProviderError('Shopify OAuth is not configured.');
    }

    const boundSecret = randomBytes(32).toString('hex');
    const state = this.encodeState({ workspaceId, nonce: randomBytes(16).toString('hex'), issuedAt: Date.now(), boundSecret });

    const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('scope', SHOPIFY_OAUTH_SCOPES);
    url.searchParams.set('redirect_uri', this.callbackUrl());
    url.searchParams.set('state', state);
    return { authorizeUrl: url.toString(), cookieValue: boundSecret, cookieMaxAgeSeconds: STATE_COOKIE_MAX_AGE_SECONDS };
  }

  /**
   * Client-credentials grant (shopify.dev — "Authenticate an app for
   * stores in your organization"): no browser redirect, no merchant
   * consent screen, no `state`/HMAC/cookie dance — the app exchanges its
   * own `client_id`/`client_secret` directly for a token. Only works for
   * a shop in the same Shopify organization as this app; Shopify itself
   * rejects the request otherwise (BRAYN adds no allowlist of its own —
   * see requestShopifyClientCredentialsToken's doc comment). Unlike
   * `handleCallback`, this is a normal authenticated request/response
   * call (no browser mid-redirect to protect), so it throws on failure
   * like any other synchronous connect path (doc 20).
   *
   * Tokens from this grant expire in ~24h with no refresh_token — unlike
   * `buildAuthorizeUrl`/`handleCallback`'s token, which this file treats
   * as non-expiring. `grantType`/`expiresAt` are stored alongside the
   * credential so ShopifyAdapter.refreshCredentials can re-mint it later
   * (see IntegrationService.getCredentials).
   */
  async connectViaClientCredentials(workspaceId: string, shopDomain: string): Promise<void> {
    if (!SHOPIFY_DOMAIN_PATTERN.test(shopDomain)) {
      throw new ValidationError('Enter a valid Shopify store domain (e.g. your-store.myshopify.com).');
    }

    const clientId = this.config.get('SHOPIFY_APP_CLIENT_ID', { infer: true });
    const clientSecret = this.config.get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    if (!clientId || !clientSecret) {
      throw new ProviderError('Shopify OAuth is not configured.');
    }

    const { accessToken, expiresIn } = await requestShopifyClientCredentialsToken(shopDomain, clientId, clientSecret);
    const credentials = {
      shopDomain,
      accessToken,
      grantType: SHOPIFY_CLIENT_CREDENTIALS_GRANT_TYPE,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };

    const verified = await this.shopifyAdapter.verifyConnection(credentials);
    if (!verified) {
      throw new ProviderError('Could not verify the client-credentials token with Shopify.');
    }

    try {
      await this.integrationService.connect(workspaceId, 'shopify');
    } catch (error) {
      // Already connected (e.g. re-authorizing) — fine, credentials below still get updated to the fresh token.
      if (!(error instanceof ConflictError)) {
        throw error;
      }
    }
    await this.integrationService.setCredentials(workspaceId, 'shopify', credentials);
  }

  /**
   * Never throws — a browser mid-redirect has nowhere to receive a thrown
   * error, only a place to be sent next. Every failure path below logs the
   * reason server-side (never the code/token) and returns a frontend URL
   * carrying a safe `?shopify=error&reason=...` instead.
   *
   * `rawQuery` (the callback's undecoded query string) is used only for
   * `verifyHmac` — see `decodeShopifyCallbackQuery`'s doc comment for why
   * the already-parsed `query` object can't be trusted for that one step.
   * Every other field below (`state`, `shop`, `code`) reads from `query`
   * as before — Fastify's normal decoding is correct for those.
   */
  async handleCallback(query: Record<string, string | undefined>, cookieValue: string | undefined, rawQuery: string): Promise<string> {
    const frontendUrl = this.config.get('FRONTEND_URL', { infer: true });

    let state: OAuthState;
    try {
      state = this.decodeState(query.state);
    } catch {
      this.logger.event('warn', 'Shopify OAuth callback: invalid or missing state', 'ShopifyOAuth');
      return `${frontendUrl}?shopify=error`;
    }

    const integrationsUrl = `${frontendUrl}/workspace/${state.workspaceId}/integrations`;

    if (!this.matchesBoundSecret(cookieValue, state.boundSecret)) {
      // Cookie missing/mismatched — this callback wasn't completed by the same browser `start` issued it to (OAuth CSRF).
      this.logger.event('warn', 'Shopify OAuth callback: session-binding cookie missing or mismatched', 'ShopifyOAuth', { workspaceId: state.workspaceId });
      return `${integrationsUrl}?shopify=error&reason=session_mismatch`;
    }

    if (Date.now() - state.issuedAt > STATE_MAX_AGE_MS) {
      this.logger.event('warn', 'Shopify OAuth callback: state expired', 'ShopifyOAuth', { workspaceId: state.workspaceId });
      return `${integrationsUrl}?shopify=error&reason=expired`;
    }

    const shop = query.shop;
    if (!shop || !SHOPIFY_DOMAIN_PATTERN.test(shop)) {
      this.logger.event('warn', 'Shopify OAuth callback: invalid shop domain', 'ShopifyOAuth', { workspaceId: state.workspaceId });
      return `${integrationsUrl}?shopify=error&reason=invalid_shop`;
    }

    if (!this.verifyHmac(rawQuery)) {
      this.logger.event('warn', 'Shopify OAuth callback: HMAC verification failed', 'ShopifyOAuth', { workspaceId: state.workspaceId });
      return `${integrationsUrl}?shopify=error&reason=invalid_signature`;
    }

    if (!query.code) {
      this.logger.event('warn', 'Shopify OAuth callback: missing code', 'ShopifyOAuth', { workspaceId: state.workspaceId });
      return `${integrationsUrl}?shopify=error&reason=missing_code`;
    }

    let accessToken: string;
    try {
      accessToken = await this.exchangeCodeForToken(shop, query.code);
    } catch {
      this.logger.event('error', 'Shopify OAuth callback: token exchange failed', 'ShopifyOAuth', { workspaceId: state.workspaceId });
      return `${integrationsUrl}?shopify=error&reason=token_exchange_failed`;
    }

    const credentials = { shopDomain: shop, accessToken };

    const verified = await this.shopifyAdapter.verifyConnection(credentials).catch(() => false);
    if (!verified) {
      this.logger.event('error', 'Shopify OAuth callback: post-exchange verification failed', 'ShopifyOAuth', { workspaceId: state.workspaceId });
      return `${integrationsUrl}?shopify=error&reason=verification_failed`;
    }

    try {
      await this.integrationService.connect(state.workspaceId, 'shopify');
    } catch (error) {
      // Already connected (e.g. re-authorizing) — fine, credentials below still get updated to the fresh token.
      if (!(error instanceof ConflictError)) {
        this.logger.event('error', 'Shopify OAuth callback: connect() failed', 'ShopifyOAuth', { workspaceId: state.workspaceId });
        return `${integrationsUrl}?shopify=error`;
      }
    }
    await this.integrationService.setCredentials(state.workspaceId, 'shopify', credentials);

    return `${integrationsUrl}?shopify=connected`;
  }

  private matchesBoundSecret(cookieValue: string | undefined, expected: string): boolean {
    if (!cookieValue) {
      return false;
    }
    const cookieBuf = Buffer.from(cookieValue, 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    return cookieBuf.length === expectedBuf.length && timingSafeEqual(cookieBuf, expectedBuf);
  }

  private callbackUrl(): string {
    const backendUrl = this.config.get('BACKEND_URL', { infer: true });
    return `${backendUrl}/api/v1/integrations/shopify/oauth/callback`;
  }

  /** Reuses the same AES-256-GCM cipher as stored provider credentials (doc 18 Secrets) rather than standing up a second secret/mechanism just for this nonce. */
  private encodeState(state: OAuthState): string {
    const key = this.resolveEncryptionKey();
    return encodeURIComponent(encryptCredential(JSON.stringify(state), key));
  }

  private decodeState(raw: string | undefined): OAuthState {
    if (!raw) {
      throw new ValidationError('Missing state.');
    }
    const key = this.resolveEncryptionKey();
    const parsed: unknown = JSON.parse(decryptCredential(decodeURIComponent(raw), key));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as OAuthState).workspaceId !== 'string' ||
      typeof (parsed as OAuthState).issuedAt !== 'number' ||
      typeof (parsed as OAuthState).boundSecret !== 'string'
    ) {
      throw new ValidationError('Malformed state.');
    }
    return parsed as OAuthState;
  }

  /**
   * shopify.dev — Authorization Code Grant: drop `hmac`, sort the
   * remaining params alphabetically by key, join as `key=value&...`,
   * HMAC-SHA256 with the app's client secret, compare timing-safe.
   *
   * Works from the raw query string via `decodeShopifyCallbackQuery`,
   * not Fastify's `@Query()` — see that function's doc comment. Malformed
   * percent-encoding fails closed (verification fails) rather than
   * throwing into the request.
   */
  private verifyHmac(rawQuery: string): boolean {
    const clientSecret = this.config.get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    if (!clientSecret) {
      return false;
    }

    let params: Record<string, string>;
    try {
      params = decodeShopifyCallbackQuery(rawQuery);
    } catch {
      return false;
    }

    const hmac = params.hmac;
    if (!hmac) {
      return false;
    }

    const message = Object.entries(params)
      .filter(([key]) => key !== 'hmac')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');

    const expected = createHmac('sha256', clientSecret).update(message).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(hmac, 'hex');
    return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
  }

  private async exchangeCodeForToken(shop: string, code: string): Promise<string> {
    const clientId = this.config.get('SHOPIFY_APP_CLIENT_ID', { infer: true });
    const clientSecret = this.config.get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    if (!clientId || !clientSecret) {
      throw new ProviderError('Shopify OAuth is not configured.');
    }

    const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code }).toString(),
    });

    if (!response.ok) {
      throw new ProviderError('Shopify rejected the authorization code.');
    }

    const body = (await response.json()) as { access_token?: string };
    if (!body.access_token) {
      throw new ProviderError('Shopify token exchange returned no access token.');
    }
    return body.access_token;
  }

  private resolveEncryptionKey() {
    try {
      return parseEncryptionKey(this.config.get('BRAYN_CREDENTIAL_ENCRYPTION_KEY', { infer: true }));
    } catch (error) {
      if (error instanceof InvalidEncryptionKeyError) {
        throw new ProviderError('Credential encryption is not configured.');
      }
      throw error;
    }
  }
}
