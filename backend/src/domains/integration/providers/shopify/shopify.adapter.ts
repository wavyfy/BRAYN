import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProviderError } from '../../../../common/errors/app-error';
import { ProviderRegistry } from '../../provider-registry.service';
import type {
  CollectionPage,
  CollectPage,
  CustomerPage,
  FetchOptions,
  OrderPage,
  ParsedWebhookEvent,
  ProductPage,
  ProviderAdapter,
  WebhookResourceEvent,
} from '../../provider-adapter.interface';
import type { NormalizedCustomer } from '../../../commerce/customer.service';
import type { NormalizedFulfillment, NormalizedOrder, NormalizedRefund } from '../../../commerce/order.service';
import type { NormalizedProduct } from '../../../commerce/product.service';
import type { NormalizedCollect, NormalizedCollection } from '../../../commerce/collection.service';
import type { Env } from '../../../../config/env.schema';

const SHOPIFY_API_VERSION = '2024-10';

/**
 * Non-sensitive classification of a verifyConnection() outcome (doc 20
 * Part 20/22/25) — never a token/domain/full body. `category`
 * distinguishes 401 from 403 exactly (Part 22 — a combined "401_403"
 * bucket wasn't enough to tell an invalid/expired token apart from a
 * scopes/permissions problem). `shopifyError` (Part 25) is Shopify's own
 * `errors` field from the response body — its explanation for *why* —
 * extracted on its own, never the complete response body.
 */
export interface ShopifyConnectionCheckDiagnostic {
  category: '200' | '401' | '403' | '404' | 'other_4xx' | 'server_error' | 'network_error';
  apiVersionHeader: string | null;
  shopifyError: string | null;
}

/**
 * Extracts only the `errors` field from a Shopify error response body
 * (doc 20 Part 25) — never the full body, never customer/store data.
 * Shopify's REST API returns `{"errors": "some message"}` for a simple
 * permission error, or `{"errors": {"field": ["message"]}}` for a
 * validation error; either shape is reduced to a single string here.
 * Never throws — a missing/invalid/unparseable body yields `null`, since
 * this is diagnostic-only and must never break the actual verification
 * outcome it's attached to.
 */
async function readShopifyErrorField(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();
    if (!body || typeof body !== 'object' || !('errors' in body)) {
      return null;
    }
    const errors = (body as { errors?: unknown }).errors;
    if (typeof errors === 'string') {
      return errors;
    }
    if (errors && typeof errors === 'object') {
      return JSON.stringify(errors);
    }
    return null;
  } catch {
    return null;
  }
}

const CUSTOMERS_PAGE_SIZE = 250;
const PRODUCTS_PAGE_SIZE = 250;
const ORDERS_PAGE_SIZE = 250;
const COLLECTIONS_PAGE_SIZE = 250;
const COLLECTS_PAGE_SIZE = 250;
/**
 * Every Shopify store domain, whether merchant-typed (manual flow) or
 * Shopify-supplied (`shop` param on an OAuth callback) — must be pinned to
 * this pattern before it drives any fetch() or OAuth redirect (SSRF).
 * Exported so ShopifyOAuthService validates against the exact same rule.
 */
export const SHOPIFY_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

/** Tags a stored credential as having come from the client-credentials grant (shopify.dev — "Authenticate an app for stores in your organization") — see ShopifyOAuthService.connectViaClientCredentials and ShopifyAdapter.refreshCredentials. */
export const SHOPIFY_CLIENT_CREDENTIALS_GRANT_TYPE = 'client_credentials';

/**
 * Shopify's client-credentials grant (shopify.dev): the app exchanges its
 * own `client_id`/`client_secret` directly for a token — no `redirect_uri`,
 * no merchant consent screen, no `state`. Only works for a shop in the
 * same Shopify organization as this app; Shopify itself rejects the
 * request otherwise (BRAYN adds no allowlist of its own here — that check
 * belongs to Shopify, not duplicated in this codebase). The resulting
 * token expires in ~24h (`expires_in`) with no refresh_token — the caller
 * re-requests the same way when it's about to expire.
 *
 * Exported so both ShopifyOAuthService (initial connect) and
 * ShopifyAdapter.refreshCredentials (re-mint on expiry) share one
 * implementation rather than two copies of the same HTTP call.
 */
export async function requestShopifyClientCredentialsToken(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: SHOPIFY_CLIENT_CREDENTIALS_GRANT_TYPE,
      client_id: clientId,
      client_secret: clientSecret,
    }).toString(),
  });

  if (!response.ok) {
    throw new ProviderError('Shopify rejected the client credentials request.');
  }

  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new ProviderError('Shopify client credentials response had no access token.');
  }

  // shopify.dev: "Always 86399" — falling back to it only if a future API response omits the field.
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? 86399 };
}

/** Tags a stored credential as having come from the standalone-app authorization-code grant (doc 20 Part 28) — see ShopifyOAuthService.handleCallback and ShopifyAdapter.refreshCredentials. */
export const SHOPIFY_AUTHORIZATION_CODE_GRANT_TYPE = 'authorization_code';

/**
 * Refreshes an expiring offline access token (shopify.dev — "Refresh an
 * expiring offline access token"): same `/admin/oauth/access_token`
 * endpoint as the initial exchange, but `grant_type=refresh_token` plus
 * the stored `refresh_token` instead of an authorization `code`. Shopify
 * rotates the refresh token on every use — the response's `refresh_token`
 * is a *new* value, and the old one stops working, so callers must
 * persist both the new access and refresh tokens together, never just
 * the access token.
 */
async function requestShopifyRefreshedToken(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!response.ok) {
    throw new ProviderError('Shopify rejected the refresh token request.');
  }

  const body = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
  };
  if (!body.access_token || !body.refresh_token) {
    throw new ProviderError('Shopify refresh-token response was missing an access or refresh token.');
  }

  // shopify.dev: access tokens from this grant expire in 1 hour (3600s) — falling back only if a future response omits the field.
  return { accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in ?? 3600 };
}

interface ShopifyCustomer {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  updated_at: string;
}

interface ShopifyVariant {
  id: number;
  sku: string | null;
  price: string | null;
  inventory_quantity: number | null;
  updated_at: string;
}

interface ShopifyProduct {
  id: number;
  title: string;
  updated_at: string;
  variants: ShopifyVariant[];
}

interface ShopifyLineItem {
  id: number;
  variant_id: number | null;
  quantity: number;
  price: string | null;
}

interface ShopifyRefundLineItem {
  id: number;
  line_item_id: number | null;
  quantity: number;
}

interface ShopifyRefundTransaction {
  amount: string | null;
  status: string | null;
}

interface ShopifyRefund {
  id: number;
  note: string | null;
  processed_at: string | null;
  refund_line_items: ShopifyRefundLineItem[];
  transactions: ShopifyRefundTransaction[];
}

interface ShopifyFulfillment {
  id: number;
  order_id: number;
  status: string | null;
  tracking_company: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipment_status: string | null;
  updated_at: string | null;
}

interface ShopifyCollection {
  id: number;
  title: string;
  updated_at: string;
}

interface ShopifyCollect {
  id: number;
  collection_id: number;
  product_id: number;
}

interface ShopifyOrder {
  id: number;
  customer: { id: number } | null;
  total_price: string | null;
  updated_at: string;
  line_items: ShopifyLineItem[];
  /** Embedded, not a separate resource — Shopify has no top-level refunds list/webhook (doc 20 Shopify Phase 1 Data — "Refunds"). */
  refunds: ShopifyRefund[];
  /** Embedded here too, in addition to its own `fulfillments/create`/`fulfillments/update` webhook topics — see normalizeFulfillment's doc comment. */
  fulfillments: ShopifyFulfillment[];
}

/**
 * Admin API access, independent of how the token was obtained (doc 20 —
 * "Use Shopify-supported application/API mechanisms"). The merchant-facing
 * connection path is now Shopify OAuth (see ShopifyOAuthService, same
 * folder): the merchant authorizes BRAYN on Shopify's own consent screen,
 * and the resulting `access_token` is stored through this same credential
 * shape. `verifyConnection()` here is reused as OAuth's post-exchange
 * sanity check — this adapter has no OAuth-specific code of its own,
 * because the credential shape (`shopDomain` + `accessToken`) is identical
 * either way.
 *
 * credentials shape: `{ shopDomain: "your-store.myshopify.com", accessToken: "shpat_..." }` for
 * the authorization-code/manual paths (no expiry tracked); the client-credentials
 * grant (BRAYN's own organization's stores only — see ShopifyOAuthService.
 * connectViaClientCredentials) adds `grantType: "client_credentials"` and
 * `expiresAt` (ISO string) alongside the same two fields.
 */
@Injectable()
export class ShopifyAdapter implements ProviderAdapter, OnModuleInit {
  readonly provider = 'shopify' as const;

  constructor(
    private readonly registry: ProviderRegistry,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Re-mints an expiring token before it expires (doc07 —
   * IntegrationService.getCredentials calls this generically off
   * `credentials.expiresAt`). Two grant shapes, dispatched by
   * `credentials.grantType`; any other shape (WooCommerce, or a Shopify
   * credential with no expiry) returns `null` — nothing to do. Throws
   * (never returns partial data) on any failure, matching the existing
   * client-credentials branch's convention — `IntegrationService.
   * refreshIfExpiring` never catches this, so a thrown error here leaves
   * the previously-stored credentials in the database untouched rather
   * than overwriting them with something invalid (doc 20 Part 28).
   */
  async refreshCredentials(credentials: Record<string, string>): Promise<Record<string, string> | null> {
    if (credentials.grantType === SHOPIFY_AUTHORIZATION_CODE_GRANT_TYPE) {
      const { shopDomain, refreshToken } = credentials;
      const clientId = this.config.get('SHOPIFY_APP_CLIENT_ID', { infer: true });
      const clientSecret = this.config.get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
      if (!shopDomain || !refreshToken || !clientId || !clientSecret) {
        throw new ProviderError('Shopify authorization-code refresh is not configured.');
      }

      const refreshed = await requestShopifyRefreshedToken(shopDomain, clientId, clientSecret, refreshToken);
      return {
        shopDomain,
        accessToken: refreshed.accessToken,
        // Shopify rotates the refresh token on every use — the old one stops working, so the
        // newly-returned one must replace it, never just the access token (doc 20 Part 28).
        refreshToken: refreshed.refreshToken,
        grantType: SHOPIFY_AUTHORIZATION_CODE_GRANT_TYPE,
        expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000).toISOString(),
      };
    }

    if (credentials.grantType !== SHOPIFY_CLIENT_CREDENTIALS_GRANT_TYPE) {
      return null;
    }

    const { shopDomain } = credentials;
    const clientId = this.config.get('SHOPIFY_APP_CLIENT_ID', { infer: true });
    const clientSecret = this.config.get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    if (!shopDomain || !clientId || !clientSecret) {
      throw new ProviderError('Shopify client-credentials refresh is not configured.');
    }

    const { accessToken, expiresIn } = await requestShopifyClientCredentialsToken(shopDomain, clientId, clientSecret);
    return {
      shopDomain,
      accessToken,
      grantType: SHOPIFY_CLIENT_CREDENTIALS_GRANT_TYPE,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  /**
   * Smallest real Shopify API call that proves the token actually works:
   * GET shop.json, the same request Shopify's own docs use as the
   * canonical "is this token valid" check.
   *
   * `onDiagnostic` (doc 20 Part 20) is an optional, fingerprint-safe hook
   * — a status-code *category* plus the non-sensitive `X-Shopify-API-Version`
   * response header, never the body/token/domain. Existing callers
   * (`connectViaClientCredentials`) don't pass it, so this parameter changes
   * nothing about their behavior; `ShopifyOAuthService.handleCallback` passes
   * one so its own failure log can distinguish *why* verification failed
   * (401/403 vs 404 vs 5xx vs network error) instead of a single opaque
   * boolean, without ever logging a credential or response body.
   */
  async verifyConnection(
    credentials: Record<string, string>,
    onDiagnostic?: (diagnostic: ShopifyConnectionCheckDiagnostic) => void,
  ): Promise<boolean> {
    const { shopDomain, accessToken } = credentials;
    if (!shopDomain || !accessToken || !SHOPIFY_DOMAIN_PATTERN.test(shopDomain)) {
      // A malformed domain is the merchant having entered something wrong —
      // same "ordinary rejection" bucket as a bad token, not a thrown error.
      return false;
    }

    let response: Response;
    try {
      response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/shop.json`, {
        headers: { 'X-Shopify-Access-Token': accessToken },
      });
    } catch (error) {
      // Network/DNS failure — unclassified, not an ordinary "bad credentials" outcome.
      onDiagnostic?.({ category: 'network_error', apiVersionHeader: null, shopifyError: null });
      throw new ProviderError(
        `Could not reach Shopify: ${error instanceof Error ? error.message : 'unknown network error'}.`,
      );
    }

    const apiVersionHeader = response.headers.get('x-shopify-api-version');

    // 4xx (401/403 bad token, 404 unknown shop domain, ...) is the merchant having
    // entered something wrong — an ordinary rejection, not a thrown error.
    if (response.status >= 400 && response.status < 500) {
      const category =
        response.status === 401 ? '401' : response.status === 403 ? '403' : response.status === 404 ? '404' : 'other_4xx';
      const shopifyError = onDiagnostic ? await readShopifyErrorField(response) : null;
      onDiagnostic?.({ category, apiVersionHeader, shopifyError });
      return false;
    }
    if (!response.ok) {
      const shopifyError = onDiagnostic ? await readShopifyErrorField(response) : null;
      onDiagnostic?.({ category: 'server_error', apiVersionHeader, shopifyError });
      throw new ProviderError(`Shopify connection check failed with status ${response.status}.`);
    }

    onDiagnostic?.({ category: '200', apiVersionHeader, shopifyError: null });
    return true;
  }

  /**
   * One page of the merchant's customers (doc 20 — Initial Import:
   * pagination). `cursor`, when present, is the exact next-page URL
   * Shopify returned in its previous response's `Link` header — simpler
   * and less error-prone than re-deriving Shopify's `page_info` query
   * param ourselves, and matches ImportRunService's "opaque provider-
   * specific" cursor contract.
   */
  async fetchCustomers(credentials: Record<string, string>, cursor?: string, options?: FetchOptions): Promise<CustomerPage> {
    const { body, nextCursor } = await this.fetchPage(
      credentials,
      cursor,
      `customers.json?limit=${CUSTOMERS_PAGE_SIZE}${updatedAtMinParam(options)}`,
    );
    const { customers } = body as { customers: ShopifyCustomer[] };

    return { customers: customers.map(normalizeCustomer), nextCursor };
  }

  /** Same contract/pagination as fetchCustomers, for products and their variants (doc 20 Shopify Phase 1 Data). */
  async fetchProducts(credentials: Record<string, string>, cursor?: string, options?: FetchOptions): Promise<ProductPage> {
    const { body, nextCursor } = await this.fetchPage(
      credentials,
      cursor,
      `products.json?limit=${PRODUCTS_PAGE_SIZE}${updatedAtMinParam(options)}`,
    );
    const { products } = body as { products: ShopifyProduct[] };

    return { products: products.map(normalizeProduct), nextCursor };
  }

  /**
   * Same contract/pagination as fetchCustomers, for orders and their line
   * items (doc 20 Shopify Phase 1 Data). `status=any` because Shopify's
   * default order listing excludes closed/cancelled orders — an initial
   * import needs the merchant's full order history.
   */
  async fetchOrders(credentials: Record<string, string>, cursor?: string, options?: FetchOptions): Promise<OrderPage> {
    const { body, nextCursor } = await this.fetchPage(
      credentials,
      cursor,
      `orders.json?limit=${ORDERS_PAGE_SIZE}&status=any${updatedAtMinParam(options)}`,
    );
    const { orders } = body as { orders: ShopifyOrder[] };

    return { orders: orders.map(normalizeOrder), nextCursor };
  }

  /**
   * Shopify has two distinct collection resources — CustomCollection and
   * SmartCollection — with no unified list endpoint (doc 20 Shopify Phase
   * 1 Data — "Collections"). This presents them as one paginated
   * `fetchCollections` the way every other adapter method works: `cursor`
   * carries a `custom:`/`smart:` phase prefix ahead of Shopify's own
   * opaque next-page URL so the two real endpoints stay behind this
   * boundary (doc 06 — Provider Isolation) — undefined cursor starts at
   * custom collections; once that phase's pages run out, the same call
   * immediately starts smart collections rather than returning early.
   */
  async fetchCollections(credentials: Record<string, string>, cursor?: string, options?: FetchOptions): Promise<CollectionPage> {
    const isSmartPhase = cursor?.startsWith('smart:') ?? false;
    const realCursor = cursor ? cursor.slice(cursor.indexOf(':') + 1) || undefined : undefined;

    if (!isSmartPhase) {
      const custom = await this.fetchPage(
        credentials,
        realCursor,
        `custom_collections.json?limit=${COLLECTIONS_PAGE_SIZE}${updatedAtMinParam(options)}`,
      );
      const { custom_collections: customCollections = [] } = custom.body as { custom_collections?: ShopifyCollection[] };
      if (custom.nextCursor) {
        return { collections: customCollections.map(normalizeCollection), nextCursor: `custom:${custom.nextCursor}` };
      }

      const smart = await this.fetchPage(
        credentials,
        undefined,
        `smart_collections.json?limit=${COLLECTIONS_PAGE_SIZE}${updatedAtMinParam(options)}`,
      );
      const { smart_collections: smartCollections = [] } = smart.body as { smart_collections?: ShopifyCollection[] };
      return {
        collections: [...customCollections, ...smartCollections].map(normalizeCollection),
        nextCursor: smart.nextCursor ? `smart:${smart.nextCursor}` : null,
      };
    }

    const smart = await this.fetchPage(
      credentials,
      realCursor,
      `smart_collections.json?limit=${COLLECTIONS_PAGE_SIZE}${updatedAtMinParam(options)}`,
    );
    const { smart_collections: smartCollections } = smart.body as { smart_collections: ShopifyCollection[] };
    return { collections: smartCollections.map(normalizeCollection), nextCursor: smart.nextCursor ? `smart:${smart.nextCursor}` : null };
  }

  /**
   * Product-collection membership (Shopify's `Collect` resource) — its own
   * shop-wide paginated endpoint, unrelated to a specific collection page
   * (doc 20 — collections' "Required customer/order relationships"
   * equivalent for products). No `updatedAtMinParam`: Collect has no
   * `updated_at` field to filter on — a link either exists or doesn't.
   */
  async fetchCollects(credentials: Record<string, string>, cursor?: string): Promise<CollectPage> {
    const { body, nextCursor } = await this.fetchPage(credentials, cursor, `collects.json?limit=${COLLECTS_PAGE_SIZE}`);
    const { collects } = body as { collects: ShopifyCollect[] };

    return { collects: collects.map(normalizeCollect), nextCursor };
  }

  /**
   * Verifies Shopify's `X-Shopify-Hmac-Sha256` header: base64(HMAC-SHA256(
   * rawBody, secret)) — the exact check Shopify's own webhook docs specify.
   * `secret` is whatever the merchant pasted as `credentials.webhookSecret`
   * (their custom app's API secret key, or the signing secret shown when
   * they create the webhook subscription — either way, a value only
   * Shopify and BRAYN should know, not something BRAYN issues or derives).
   */
  verifyWebhookSignature(rawBody: string, headers: Record<string, string>, secret: string): boolean {
    return verifyShopifyHmac(rawBody, headers, secret);
  }

  /**
   * Shopify puts the event topic and delivery id in headers, not the
   * body — unlike the REST list endpoints, a webhook payload is just the
   * bare resource. Only the create/update topics for customers, products,
   * orders, fulfillments, and collections are recognized (doc 21 —
   * "process only relevant events"); everything else, including deletes
   * and Collect (no `collects/*` topic exists — see CollectionService's
   * doc comment), is out of this part's scope.
   */
  parseWebhookEvent(rawBody: string, headers: Record<string, string>): ParsedWebhookEvent | null {
    const topic = headers['x-shopify-topic'];
    const resource = topic ? SHOPIFY_WEBHOOK_TOPICS[topic] : undefined;
    if (!resource) {
      return null;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const payload: WebhookResourceEvent =
      resource === 'customer'
        ? { resource, data: normalizeCustomer(raw as ShopifyCustomer) }
        : resource === 'product'
          ? { resource, data: normalizeProduct(raw as ShopifyProduct) }
          : resource === 'order'
            ? { resource, data: normalizeOrder(raw as ShopifyOrder) }
            : resource === 'fulfillment'
              ? {
                  resource,
                  data: { ...normalizeFulfillment(raw as ShopifyFulfillment), orderExternalId: String((raw as ShopifyFulfillment).order_id) },
                }
              : { resource, data: normalizeCollection(raw as ShopifyCollection) };

    // Present on every delivery since 2022, but derive a stable fallback
    // rather than reject an otherwise-valid, signature-verified delivery.
    const externalEventId = headers['x-shopify-webhook-id'] ?? `${topic}:${createHash('sha256').update(rawBody).digest('hex')}`;

    return { externalEventId, eventType: topic!, payload };
  }

  /**
   * Shared fetch+pagination for every resource page (doc 20 — Initial
   * Import: pagination). `cursor`, when present, is the exact next-page
   * URL Shopify returned in its previous response's `Link` header —
   * simpler and less error-prone than re-deriving Shopify's `page_info`
   * query param ourselves, and matches ImportRunService's "opaque
   * provider-specific" cursor contract.
   */
  private async fetchPage(
    credentials: Record<string, string>,
    cursor: string | undefined,
    defaultRelativeUrl: string,
  ): Promise<{ body: unknown; nextCursor: string | null }> {
    const { shopDomain, accessToken } = credentials;
    // verifyConnection() already validated this domain at connect time — a
    // failure here means stored credentials were tampered with or corrupted,
    // an infrastructure problem, not an ordinary rejection.
    if (!SHOPIFY_DOMAIN_PATTERN.test(shopDomain)) {
      throw new ProviderError('Stored Shopify shop domain is invalid.');
    }
    const url = cursor
      ? assertCursorMatchesShop(cursor, shopDomain)
      : `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/${defaultRelativeUrl}`;

    let response: Response;
    try {
      response = await fetch(url, { headers: { 'X-Shopify-Access-Token': accessToken } });
    } catch (error) {
      throw new ProviderError(
        `Could not reach Shopify: ${error instanceof Error ? error.message : 'unknown network error'}.`,
      );
    }
    if (!response.ok) {
      // Credentials were already verified at connect time — a failure here is
      // an infrastructure/auth problem, not an ordinary rejection to swallow.
      throw new ProviderError(`Shopify fetch failed with status ${response.status}.`);
    }

    return { body: await response.json(), nextCursor: parseNextCursor(response.headers.get('link')) };
  }
}

/**
 * Shopify's `X-Shopify-Hmac-Sha256` check — base64(HMAC-SHA256(rawBody,
 * secret)) — shared by two callers with two different secrets: a
 * per-integration topic webhook (`ShopifyAdapter.verifyWebhookSignature`,
 * `secret` = that integration's `credentials.webhookSecret`) and the
 * app-level mandatory compliance webhooks (`ShopifyComplianceService`,
 * `secret` = `SHOPIFY_APP_CLIENT_SECRET`) — same math, exported standalone
 * so neither has to duplicate it.
 */
export function verifyShopifyHmac(rawBody: string, headers: Record<string, string>, secret: string): boolean {
  const signature = headers['x-shopify-hmac-sha256'];
  if (!signature) {
    return false;
  }

  const computed = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const computedBuffer = Buffer.from(computed);
  const signatureBuffer = Buffer.from(signature);
  // timingSafeEqual throws on a length mismatch rather than returning false.
  if (computedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return timingSafeEqual(computedBuffer, signatureBuffer);
}

/** Recognized webhook topics → the commerce resource they normalize to (doc 21 — "process only relevant events"). */
const SHOPIFY_WEBHOOK_TOPICS: Record<string, 'customer' | 'product' | 'order' | 'fulfillment' | 'collection'> = {
  'customers/create': 'customer',
  'customers/update': 'customer',
  'products/create': 'product',
  'products/update': 'product',
  'orders/create': 'order',
  'orders/updated': 'order',
  'fulfillments/create': 'fulfillment',
  'fulfillments/update': 'fulfillment',
  // Unified across CustomCollection/SmartCollection — same bare payload shape either way (doc 21 — "process only relevant events").
  'collections/create': 'collection',
  'collections/update': 'collection',
};

/** Shared with fetchCustomers (list) and the customers/* webhooks (single record) — same Shopify payload shape either way. */
/**
 * Only meaningful on the first page (`cursor` undefined) — `fetchPage`
 * ignores the relative-URL argument once a cursor exists, since Shopify's
 * own `Link` header already carries every original query param forward
 * (doc 06/20 — Incremental Synchronization).
 */
function updatedAtMinParam(options?: FetchOptions): string {
  return options?.updatedAtMin ? `&updated_at_min=${encodeURIComponent(options.updatedAtMin.toISOString())}` : '';
}

function normalizeCustomer(customer: ShopifyCustomer): NormalizedCustomer {
  return {
    externalId: String(customer.id),
    email: customer.email,
    firstName: customer.first_name,
    lastName: customer.last_name,
    phone: customer.phone,
    sourceUpdatedAt: new Date(customer.updated_at),
  };
}

/** Shared with fetchProducts (list) and the products/* webhooks (single record) — same Shopify payload shape either way. */
function normalizeProduct(product: ShopifyProduct): NormalizedProduct {
  return {
    externalId: String(product.id),
    title: product.title,
    sourceUpdatedAt: new Date(product.updated_at),
    variants: product.variants.map((variant) => ({
      externalId: String(variant.id),
      sku: variant.sku,
      price: variant.price,
      inventoryQuantity: variant.inventory_quantity,
      sourceUpdatedAt: new Date(variant.updated_at),
    })),
  };
}

/** Shared with fetchOrders (list) and the orders/* webhooks (single record) — same Shopify payload shape either way. */
function normalizeOrder(order: ShopifyOrder): NormalizedOrder {
  return {
    externalId: String(order.id),
    customerExternalId: order.customer ? String(order.customer.id) : null,
    totalPrice: order.total_price,
    sourceUpdatedAt: new Date(order.updated_at),
    lineItems: order.line_items.map((item) => ({
      externalId: String(item.id),
      variantExternalId: item.variant_id !== null ? String(item.variant_id) : null,
      quantity: item.quantity,
      price: item.price,
    })),
    refunds: (order.refunds ?? []).map(normalizeRefund),
    fulfillments: (order.fulfillments ?? []).map(normalizeFulfillment),
  };
}

/** Shared with normalizeOrder's embedded `order.fulfillments[]` and the standalone fulfillments/* webhooks (same bare Shopify fulfillment shape either way). */
function normalizeFulfillment(fulfillment: ShopifyFulfillment): NormalizedFulfillment {
  return {
    externalId: String(fulfillment.id),
    status: fulfillment.status,
    trackingCompany: fulfillment.tracking_company,
    trackingNumber: fulfillment.tracking_number,
    trackingUrl: fulfillment.tracking_url,
    shipmentStatus: fulfillment.shipment_status,
    sourceUpdatedAt: fulfillment.updated_at ? new Date(fulfillment.updated_at) : null,
  };
}

/** Refunds arrive only embedded in an order (see ShopifyOrder.refunds doc comment). `totalRefunded` sums successful transaction amounts — a refund's own record carries no single total. */
function normalizeRefund(refund: ShopifyRefund): NormalizedRefund {
  const successfulAmounts = (refund.transactions ?? [])
    .filter((transaction) => transaction.status === 'success' && transaction.amount !== null)
    .map((transaction) => Number(transaction.amount));

  return {
    externalId: String(refund.id),
    note: refund.note,
    totalRefunded: successfulAmounts.length > 0 ? successfulAmounts.reduce((sum, amount) => sum + amount, 0).toFixed(2) : null,
    processedAt: refund.processed_at ? new Date(refund.processed_at) : null,
    lineItems: (refund.refund_line_items ?? []).map((item) => ({
      externalId: String(item.id),
      orderLineItemExternalId: item.line_item_id !== null ? String(item.line_item_id) : null,
      quantity: item.quantity,
    })),
  };
}

/** Shared with fetchCollections (both phases) and the collections/* webhooks (same bare shape for CustomCollection/SmartCollection either way). */
function normalizeCollection(collection: ShopifyCollection): NormalizedCollection {
  return {
    externalId: String(collection.id),
    title: collection.title,
    sourceUpdatedAt: new Date(collection.updated_at),
  };
}

function normalizeCollect(collect: ShopifyCollect): NormalizedCollect {
  return {
    externalId: String(collect.id),
    collectionExternalId: String(collect.collection_id),
    productExternalId: String(collect.product_id),
  };
}

/**
 * A malicious or corrupted `Link` header could point off-domain, taking the
 * shop's access token with it (SSRF / credential exfiltration) — pin every
 * cursor URL's host back to the verified shop domain before it's fetched.
 */
function assertCursorMatchesShop(cursor: string, shopDomain: string): string {
  let hostname: string;
  try {
    hostname = new URL(cursor).hostname;
  } catch {
    throw new ProviderError('Received an invalid pagination cursor from Shopify.');
  }
  if (hostname.toLowerCase() !== shopDomain.toLowerCase()) {
    throw new ProviderError('Pagination cursor host does not match the connected shop.');
  }
  return cursor;
}

/** Extracts the `rel="next"` URL from Shopify's `Link` pagination header, or null on the last page. */
function parseNextCursor(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }
  const next = linkHeader
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.endsWith('rel="next"'));

  return next?.match(/^<(.+)>;/)?.[1] ?? null;
}
