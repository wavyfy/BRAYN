import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ProviderError } from '../../../../common/errors/app-error';
import { ProviderRegistry } from '../../provider-registry.service';
import type {
  CustomerPage,
  FetchOptions,
  OrderPage,
  ParsedWebhookEvent,
  ProductPage,
  ProviderAdapter,
  WebhookResourceEvent,
} from '../../provider-adapter.interface';
import type { NormalizedCustomer } from '../../../commerce/customer.service';
import type { NormalizedProduct } from '../../../commerce/product.service';
import type { NormalizedOrder } from '../../../commerce/order.service';

const WC_API_PATH = 'wp-json/wc/v3';
const CUSTOMERS_PAGE_SIZE = 100;
const PRODUCTS_PAGE_SIZE = 100;
const ORDERS_PAGE_SIZE = 100;

interface WooCommerceCustomer {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  date_modified_gmt: string | null;
  billing?: { phone?: string | null };
}

interface WooCommerceProduct {
  id: number;
  name: string;
  date_modified_gmt: string | null;
  sku: string | null;
  price: string | null;
  stock_quantity: number | null;
}

interface WooCommerceLineItem {
  id: number;
  product_id: number | null;
  variation_id: number | null;
  quantity: number;
  price: string | null;
}

interface WooCommerceOrder {
  id: number;
  /** 0 for a guest checkout (WooCommerce convention) — never null/absent. */
  customer_id: number;
  total: string | null;
  date_modified_gmt: string | null;
  line_items: WooCommerceLineItem[];
}

/**
 * Consumer key/secret Basic Auth connection (doc 20 WooCommerce —
 * "Use the merchant's WooCommerce REST API"; "Credentials remain
 * server-side"). Unlike Shopify's fixed `*.myshopify.com` domain,
 * `storeUrl` is the merchant's own arbitrary WordPress domain — no
 * fixed-suffix pin is possible, so this instead requires HTTPS and
 * rejects hostnames that are loopback/private/link-local (SSRF: a
 * malicious or compromised workspace owner could otherwise point BRAYN's
 * server at internal infrastructure).
 *
 * ponytail: the SSRF guard checks the literal hostname string only, not
 * its resolved IP — a DNS name that *resolves* to a private address
 * (rebinding, or just an internal DNS entry) isn't caught. Upgrade to
 * resolving + pinning the IP at fetch time if this becomes a real
 * threat-model concern; today's mitigation matches ShopifyAdapter's own
 * (hostname-string, not resolved-IP) SSRF guard.
 *
 * credentials shape: `{ storeUrl: "https://merchant-store.com", consumerKey: "ck_...", consumerSecret: "cs_..." }`.
 */
@Injectable()
export class WooCommerceAdapter implements ProviderAdapter, OnModuleInit {
  readonly provider = 'woocommerce' as const;

  constructor(private readonly registry: ProviderRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Smallest real authenticated WooCommerce API call that proves the
   * consumer key/secret actually work: GET customers with a minimal page
   * size — a core resource every WooCommerce install exposes, unlike the
   * bare `/wp-json/wc/v3` index (which some installs leave unauthenticated).
   */
  async verifyConnection(credentials: Record<string, string>): Promise<boolean> {
    const { storeUrl, consumerKey, consumerSecret } = credentials;
    if (!storeUrl || !consumerKey || !consumerSecret) {
      return false;
    }

    const url = parseStoreUrl(storeUrl);
    if (!url) {
      // A malformed URL, non-HTTPS scheme, or private/loopback host is the
      // merchant having entered something wrong (or a blocked SSRF attempt)
      // — an ordinary rejection, not a thrown error.
      return false;
    }

    let response: Response;
    try {
      response = await fetch(resolveWcUrl(url, 'customers?per_page=1'), { headers: authHeader(consumerKey, consumerSecret) });
    } catch (error) {
      // Network/DNS failure — unclassified, not an ordinary "bad credentials" outcome.
      throw new ProviderError(
        `Could not reach WooCommerce store: ${error instanceof Error ? error.message : 'unknown network error'}.`,
      );
    }

    // 4xx (401 bad key/secret, 404 REST API not enabled/wrong URL, ...) is the
    // merchant having entered something wrong — an ordinary rejection.
    if (response.status >= 400 && response.status < 500) {
      return false;
    }
    if (!response.ok) {
      throw new ProviderError(`WooCommerce connection check failed with status ${response.status}.`);
    }

    return true;
  }

  /**
   * One page of the merchant's customers (doc 20 — Initial Import:
   * pagination). `cursor`, when present, is the exact next-page URL
   * WooCommerce returned in its previous response's `Link` header — same
   * "opaque provider-specific" cursor contract ShopifyAdapter uses.
   *
   * `options.updatedAtMin` isn't applied: unlike products/orders below,
   * WooCommerce's customers list has no modified-since filter at all
   * (only `orderby=registered_date`, not a `date_modified` filter) — a
   * "sync" of customers is necessarily a full re-fetch, not a true
   * incremental one. Still safe: every apply is idempotent.
   */
  async fetchCustomers(credentials: Record<string, string>, cursor?: string): Promise<CustomerPage> {
    const { body, nextCursor } = await this.fetchPage(credentials, cursor, `customers?per_page=${CUSTOMERS_PAGE_SIZE}`);
    const customers = body as WooCommerceCustomer[];

    return { customers: customers.map(normalizeCustomer), nextCursor };
  }

  /**
   * Same contract/pagination as fetchCustomers, for products (doc 20
   * WooCommerce Phase 1 Data — "Products"; note, unlike Shopify, there is
   * no "Variants" line item for WooCommerce).
   *
   * WooCommerce's `product.variations` is only an array of variation IDs
   * — full variant detail lives at a *separate*, *per-product* endpoint
   * (`/products/{id}/variations`), an N+1 call pattern doc 20 doesn't ask
   * BRAYN to pay for here. Each product instead maps to BRAYN's existing
   * product/variant shape as a single synthetic "default variant" built
   * from the product's own top-level sku/price/stock_quantity — exact for
   * a `simple` product (which has no real variants), an approximation for
   * a `variable` one.
   *
   * ponytail: real per-variation import (`/products/{id}/variations`) is
   * deferred — add a dedicated fetch if a real variable-product catalog
   * demonstrates the approximation isn't good enough.
   *
   * Unlike fetchCustomers, `options.updatedAtMin` applies here — the
   * products list supports `modified_after` (doc 06/20 — Incremental
   * Synchronization).
   */
  async fetchProducts(credentials: Record<string, string>, cursor?: string, options?: FetchOptions): Promise<ProductPage> {
    const { body, nextCursor } = await this.fetchPage(
      credentials,
      cursor,
      `products?per_page=${PRODUCTS_PAGE_SIZE}${modifiedAfterParam(options)}`,
    );
    const products = body as WooCommerceProduct[];

    return { products: products.map(normalizeProduct), nextCursor };
  }

  /**
   * Same contract/pagination as fetchCustomers, for orders and their line
   * items (doc 20 WooCommerce Phase 1 Data — "Orders", "Order line
   * items"). `status=any` matches this endpoint's own default (unlike
   * Shopify, whose default excludes closed/cancelled orders) — passed
   * explicitly so a future WooCommerce default change can't silently
   * narrow BRAYN's import.
   *
   * Like fetchProducts, `options.updatedAtMin` applies — orders also
   * support `modified_after`.
   */
  async fetchOrders(credentials: Record<string, string>, cursor?: string, options?: FetchOptions): Promise<OrderPage> {
    const { body, nextCursor } = await this.fetchPage(
      credentials,
      cursor,
      `orders?per_page=${ORDERS_PAGE_SIZE}&status=any${modifiedAfterParam(options)}`,
    );
    const orders = body as WooCommerceOrder[];

    return { orders: orders.map(normalizeOrder), nextCursor };
  }

  /**
   * Verifies WooCommerce's `X-WC-Webhook-Signature` header:
   * base64(HMAC-SHA256(rawBody, secret)) — same algorithm as Shopify's
   * own webhook signature, just a different header name. `secret` is
   * whatever the merchant pasted as `credentials.webhookSecret` (the
   * secret shown when they create the webhook in WooCommerce Settings →
   * Advanced → Webhooks, or via the Webhook REST resource).
   */
  verifyWebhookSignature(rawBody: string, headers: Record<string, string>, secret: string): boolean {
    const signature = headers['x-wc-webhook-signature'];
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

  /**
   * WooCommerce puts the topic in a header (`X-WC-Webhook-Topic`, e.g.
   * `customer.updated`), and the body is "exactly the same as if
   * requested via the REST API" — the same bare resource shape
   * fetchCustomers/fetchProducts/fetchOrders already normalize, so this
   * reuses those same normalize* functions. Only the create/update topics
   * for customers, products, and orders are recognized (doc 21 —
   * "process only relevant events"); deletes are out of this part's scope.
   */
  parseWebhookEvent(rawBody: string, headers: Record<string, string>): ParsedWebhookEvent | null {
    const topic = headers['x-wc-webhook-topic'];
    const resource = topic ? WOOCOMMERCE_WEBHOOK_TOPICS[topic] : undefined;
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
        ? { resource, data: normalizeCustomer(raw as WooCommerceCustomer) }
        : resource === 'product'
          ? { resource, data: normalizeProduct(raw as WooCommerceProduct) }
          : { resource, data: normalizeOrder(raw as WooCommerceOrder) };

    // WooCommerce's own delivery-log id, but derive a stable fallback rather
    // than reject an otherwise-valid, signature-verified delivery if it's absent.
    const externalEventId = headers['x-wc-webhook-delivery-id'] ?? `${topic}:${createHash('sha256').update(rawBody).digest('hex')}`;

    return { externalEventId, eventType: topic!, payload };
  }

  /**
   * Shared fetch+pagination for every resource page (doc 20 — Initial
   * Import: pagination). Unlike `verifyConnection`, a validation failure
   * here throws rather than returning false — credentials/storeUrl were
   * already verified at connect time, so a failure here means stored
   * state was tampered with or corrupted, an infrastructure problem.
   */
  private async fetchPage(
    credentials: Record<string, string>,
    cursor: string | undefined,
    defaultRelativePath: string,
  ): Promise<{ body: unknown; nextCursor: string | null }> {
    const { storeUrl, consumerKey, consumerSecret } = credentials;
    const baseUrl = parseStoreUrl(storeUrl);
    if (!baseUrl) {
      throw new ProviderError('Stored WooCommerce store URL is invalid.');
    }

    const url = cursor ? assertCursorMatchesStore(cursor, baseUrl.hostname) : resolveWcUrl(baseUrl, defaultRelativePath);

    let response: Response;
    try {
      response = await fetch(url, { headers: authHeader(consumerKey, consumerSecret) });
    } catch (error) {
      throw new ProviderError(
        `Could not reach WooCommerce store: ${error instanceof Error ? error.message : 'unknown network error'}.`,
      );
    }
    if (!response.ok) {
      // Credentials were already verified at connect time — a failure here is
      // an infrastructure/auth problem, not an ordinary rejection to swallow.
      throw new ProviderError(`WooCommerce fetch failed with status ${response.status}.`);
    }

    return { body: await response.json(), nextCursor: parseNextCursor(response.headers.get('link')) };
  }
}

/** Recognized webhook topics → the commerce resource they normalize to (doc 21 — "process only relevant events"). */
const WOOCOMMERCE_WEBHOOK_TOPICS: Record<string, 'customer' | 'product' | 'order'> = {
  'customer.created': 'customer',
  'customer.updated': 'customer',
  'product.created': 'product',
  'product.updated': 'product',
  'order.created': 'order',
  'order.updated': 'order',
};

/** Resolves and validates `storeUrl`; null on anything that should be treated as an ordinary rejection (see WooCommerceAdapter's doc comment). */
function parseStoreUrl(storeUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(storeUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || isPrivateOrLoopbackHost(url.hostname)) {
    return null;
  }
  return url;
}

/** Joins the WooCommerce REST API path onto `baseUrl`, preserving any subpath the merchant's store runs under (e.g. `https://example.com/shop`). */
function resolveWcUrl(baseUrl: URL, relativePath: string): URL {
  return new URL(`${trimTrailingSlash(baseUrl.pathname)}/${WC_API_PATH}/${relativePath}`, baseUrl);
}

/**
 * Only meaningful on the first page (`cursor` undefined) — `fetchPage`
 * ignores the relative-path argument once a cursor exists, since the
 * `Link` header's next-page URL already carries every original query
 * param forward (doc 06/20 — Incremental Synchronization). Same
 * convention as ShopifyAdapter's `updatedAtMinParam`.
 */
function modifiedAfterParam(options?: FetchOptions): string {
  return options?.updatedAtMin ? `&modified_after=${encodeURIComponent(options.updatedAtMin.toISOString())}` : '';
}

function authHeader(consumerKey: string, consumerSecret: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}` };
}

function trimTrailingSlash(pathname: string): string {
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/** IPv4/IPv6 loopback, private, and link-local ranges — see WooCommerceAdapter's doc comment for what this does and doesn't cover. */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost') {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return (
      a === 127 || // loopback
      a === 10 || // private
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 169 && b === 254) || // link-local
      a === 0 // "this network"
    );
  }

  const normalized = host.replace(/^\[|\]$/g, '');
  return normalized === '::1' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd');
}

/**
 * Same SSRF reasoning as ShopifyAdapter's `assertCursorMatchesShop`: a
 * malicious or corrupted `Link` header could point off-store, taking the
 * consumer key/secret with it — pin every cursor URL's host back to the
 * verified store before it's fetched.
 */
function assertCursorMatchesStore(cursor: string, storeHostname: string): string {
  let hostname: string;
  try {
    hostname = new URL(cursor).hostname;
  } catch {
    throw new ProviderError('Received an invalid pagination cursor from WooCommerce.');
  }
  if (hostname.toLowerCase() !== storeHostname.toLowerCase()) {
    throw new ProviderError('Pagination cursor host does not match the connected store.');
  }
  return cursor;
}

/** Extracts the `rel="next"` URL from WooCommerce's `Link` pagination header, or null on the last page — same format as Shopify's. */
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

function normalizeCustomer(customer: WooCommerceCustomer): NormalizedCustomer {
  return {
    externalId: String(customer.id),
    email: customer.email,
    firstName: customer.first_name,
    lastName: customer.last_name,
    phone: customer.billing?.phone ?? null,
    sourceUpdatedAt: customer.date_modified_gmt ? parseGmtDate(customer.date_modified_gmt) : null,
  };
}

/** See fetchProducts' doc comment for why this is a single synthetic variant built from the product's own top-level fields, not real per-variation data. */
function normalizeProduct(product: WooCommerceProduct): NormalizedProduct {
  const sourceUpdatedAt = product.date_modified_gmt ? parseGmtDate(product.date_modified_gmt) : null;

  return {
    externalId: String(product.id),
    title: product.name,
    sourceUpdatedAt,
    variants: [
      {
        externalId: String(product.id),
        sku: product.sku,
        price: product.price,
        inventoryQuantity: product.stock_quantity,
        sourceUpdatedAt,
      },
    ],
  };
}

/**
 * `line_items` arrive embedded, unlike products' variations (doc 20
 * WooCommerce Phase 1 Data). Each line's `variantExternalId` links via
 * `product_id`, not `variation_id` — WooCommerce's real per-variation ids
 * were never imported as their own variant rows (see fetchProducts' doc
 * comment), so `product_id` is the only id that actually resolves to a
 * `commerce_product_variants` row for a variable-product line.
 */
function normalizeOrder(order: WooCommerceOrder): NormalizedOrder {
  return {
    externalId: String(order.id),
    customerExternalId: order.customer_id !== 0 ? String(order.customer_id) : null,
    totalPrice: order.total,
    sourceUpdatedAt: order.date_modified_gmt ? parseGmtDate(order.date_modified_gmt) : null,
    lineItems: order.line_items.map((item) => ({
      externalId: String(item.id),
      variantExternalId: item.product_id !== null ? String(item.product_id) : null,
      quantity: item.quantity,
      price: item.price,
    })),
    refunds: [],
    fulfillments: [],
  };
}

/** WooCommerce's `_gmt` fields are UTC by definition but come back without a timezone designator (e.g. "2026-01-01T12:00:00") — `Date` would otherwise parse that as local time. */
function parseGmtDate(value: string): Date {
  return new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
}
