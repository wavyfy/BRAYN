import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
import type { ShopifyConnectionCheckDiagnostic } from './shopify.adapter';
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

export interface Fingerprint {
  length: number;
  sha256: string;
}

/** Non-reversible stand-in for a raw value in diagnostics (doc 20 Part 16) — never log the value itself, only this. */
export function fingerprint(value: string): Fingerprint {
  return { length: value.length, sha256: createHash('sha256').update(value).digest('hex') };
}

function fingerprintParams(params: Record<string, string>): Record<string, Fingerprint> {
  const result: Record<string, Fingerprint> = {};
  for (const [key, value] of Object.entries(params)) {
    result[key] = fingerprint(value);
  }
  return result;
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
      // Diagnostic only (doc 20 Part 16, supersedes Part 14's flatter version) —
      // fingerprints/lengths only, never a raw value. See buildHmacFailureDiagnostics's
      // own doc comment. Temporary — remove once the investigation concludes.
      this.logger.event('warn', 'Shopify OAuth callback: HMAC verification failed', 'ShopifyOAuth', {
        workspaceId: state.workspaceId,
        ...this.buildHmacFailureDiagnostics(query, rawQuery),
      });
      return `${integrationsUrl}?shopify=error&reason=invalid_signature`;
    }

    if (!query.code) {
      this.logger.event('warn', 'Shopify OAuth callback: missing code', 'ShopifyOAuth', { workspaceId: state.workspaceId });
      return `${integrationsUrl}?shopify=error&reason=missing_code`;
    }

    let accessToken: string;
    let grantedScopes: string | null = null;
    try {
      const exchanged = await this.exchangeCodeForToken(shop, query.code);
      accessToken = exchanged.accessToken;
      grantedScopes = exchanged.scope;
    } catch {
      this.logger.event('error', 'Shopify OAuth callback: token exchange failed', 'ShopifyOAuth', { workspaceId: state.workspaceId });
      return `${integrationsUrl}?shopify=error&reason=token_exchange_failed`;
    }

    const credentials = { shopDomain: shop, accessToken };

    // Diagnostic only (doc 20 Part 20/25) — a status-code category, the non-sensitive
    // X-Shopify-API-Version header, and Shopify's own `errors` message (not the full
    // body) — never the token/domain/customer data. Captured via the callback since
    // verifyConnection() only returns/throws a boolean either way.
    let connectionCheck: ShopifyConnectionCheckDiagnostic | undefined;
    const verified = await this.shopifyAdapter
      .verifyConnection(credentials, (diagnostic) => {
        connectionCheck = diagnostic;
      })
      .catch(() => false);
    if (!verified) {
      this.logger.event('error', 'Shopify OAuth callback: post-exchange verification failed', 'ShopifyOAuth', {
        workspaceId: state.workspaceId,
        grantedScopes,
        connectionCheck: connectionCheck ?? { category: 'unknown', apiVersionHeader: null, shopifyError: null },
      });
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
   * doc 20 Part 18 — matches Shopify's own official Node library
   * (`generateLocalHmac`/`stringifyQueryForAdmin` in `shopify-api-js`)
   * exactly, not the simplified naive-concatenation shown in shopify.dev's
   * prose (which Part 11 followed and which turned out to be incomplete):
   * drop both `hmac` and `signature`, sort the remaining keys with
   * `localeCompare`, then build the message via `URLSearchParams` — NOT
   * `${key}=${value}` string concatenation of the already-decoded value.
   * `URLSearchParams.append()`+`.toString()` re-encodes each value using
   * application/x-www-form-urlencoded rules, which differs from a naive
   * join whenever a value contains `+`, `/`, `=`, or another character
   * that needs encoding — exactly what a base64-shaped value like `host`
   * (or BRAYN's own `state`) contains. Confirmed via direct reproduction
   * against Shopify's actual source before this fix (Part 17).
   *
   * Pure — no secret, no comparison — kept as its own method so
   * `buildHmacFailureDiagnostics` (doc 20 Part 16) can recompute the exact
   * same message for fingerprinting without duplicating this logic or
   * changing `verifyHmac`'s own behavior.
   */
  private buildHmacMessage(rawQuery: string): { message: string; receivedHmac: string | undefined } | null {
    let params: Record<string, string>;
    try {
      params = decodeShopifyCallbackQuery(rawQuery);
    } catch {
      return null;
    }

    const signedParams = new URLSearchParams();
    for (const key of Object.keys(params)
      .filter((key) => key !== 'hmac' && key !== 'signature')
      .sort((a, b) => a.localeCompare(b))) {
      signedParams.append(key, params[key]);
    }

    return { message: signedParams.toString(), receivedHmac: params.hmac };
  }

  /**
   * HMAC-SHA256 with the app's client secret, compare timing-safe. Works
   * from the raw query string via `buildHmacMessage`/
   * `decodeShopifyCallbackQuery`, not Fastify's `@Query()` — see that
   * function's doc comment. Malformed percent-encoding fails closed
   * (verification fails) rather than throwing into the request. Message
   * construction itself lives in `buildHmacMessage` — see its doc comment
   * for the Part 18 canonicalization fix.
   */
  private verifyHmac(rawQuery: string): boolean {
    const clientSecret = this.config.get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    if (!clientSecret) {
      return false;
    }

    const built = this.buildHmacMessage(rawQuery);
    if (!built || !built.receivedHmac) {
      return false;
    }

    const expected = createHmac('sha256', clientSecret).update(built.message).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    const actualBuf = Buffer.from(built.receivedHmac, 'hex');
    return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
  }

  /**
   * Temporary, staging-safe diagnostic (doc 20 Part 16) — never logs a
   * raw value, only SHA-256 fingerprints + lengths, so it's safe to keep
   * in the HMAC-failure branch while diagnosing a real callback failure.
   * Lets us tell apart: (A) wrong secret, (B) Shopify's actual param
   * values differing from what we expect, (C) our decoding corrupting a
   * value Fastify's parser got right (or vice versa), (D) a message-
   * construction bug — by comparing fingerprints across both decode
   * paths and the HMAC inputs/output, without ever exposing the
   * underlying bytes. Remove once the investigation concludes.
   */
  private buildHmacFailureDiagnostics(query: Record<string, string | undefined>, rawQuery: string) {
    const parsedParams: Record<string, string> = {};
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        parsedParams[key] = value;
      }
    }
    const parsed = fingerprintParams(parsedParams);

    let rawDecodedParams: Record<string, string> = {};
    try {
      rawDecodedParams = decodeShopifyCallbackQuery(rawQuery);
    } catch {
      rawDecodedParams = {};
    }
    const rawDecoded = fingerprintParams(rawDecodedParams);

    const comparison: Record<string, 'same' | 'different'> = {};
    for (const key of new Set([...Object.keys(parsed), ...Object.keys(rawDecoded)])) {
      comparison[key] = parsed[key] && rawDecoded[key] && parsed[key].sha256 === rawDecoded[key].sha256 ? 'same' : 'different';
    }

    const clientSecret = this.config.get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    const built = this.buildHmacMessage(rawQuery);
    const expected = built && clientSecret ? createHmac('sha256', clientSecret).update(built.message).digest('hex') : undefined;

    return {
      parsed,
      rawDecoded,
      comparison,
      signedMessage: built ? fingerprint(built.message) : null,
      receivedHmac: built?.receivedHmac ? fingerprint(built.receivedHmac) : null,
      expectedHmac: expected ? fingerprint(expected) : null,
      clientSecret: { configured: Boolean(clientSecret), sha256: clientSecret ? fingerprint(clientSecret).sha256 : null },
    };
  }

  /**
   * `scope` (doc 20 Part 25) is Shopify's own report of which scopes this
   * token actually carries — not a secret (it's a permission-name list,
   * same category as the `scope` param BRAYN itself puts on the authorize
   * URL), captured here so a post-exchange verification failure can be
   * diagnosed against what was actually granted instead of what was
   * requested, without a second API call.
   */
  private async exchangeCodeForToken(shop: string, code: string): Promise<{ accessToken: string; scope: string | null }> {
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

    const body = (await response.json()) as { access_token?: string; scope?: string };
    if (!body.access_token) {
      throw new ProviderError('Shopify token exchange returned no access token.');
    }
    return { accessToken: body.access_token, scope: typeof body.scope === 'string' ? body.scope : null };
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
