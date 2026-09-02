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
import type { NormalizedFulfillment, NormalizedOrder, NormalizedRefund } from '../../../commerce/order.service';
import type { NormalizedProduct } from '../../../commerce/product.service';

const SHOPIFY_API_VERSION = '2024-10';
const CUSTOMERS_PAGE_SIZE = 250;
const PRODUCTS_PAGE_SIZE = 250;
const ORDERS_PAGE_SIZE = 250;
/** Merchant-supplied at connect time — must be pinned to Shopify's own domain before it drives any fetch() (SSRF). */
const SHOPIFY_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

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
 * Custom-app Admin API token connection (doc 20 — "Use Shopify-supported
 * application/API mechanisms"). This is a development/initial provider-
 * auth mechanism, not BRAYN's permanent merchant onboarding story: the
 * merchant pastes a token generated from their store's own Custom App
 * settings, rather than going through a full OAuth authorization-code
 * flow. Deliberately kept behind ProviderAdapter and the existing
 * encrypted-credential storage (Phase 3) so swapping to OAuth later only
 * means changing this file's verifyConnection() / a new authorize+
 * callback flow — nothing in the Integration domain model changes.
 *
 * credentials shape: `{ shopDomain: "your-store.myshopify.com", accessToken: "shpat_..." }`.
 */
@Injectable()
export class ShopifyAdapter implements ProviderAdapter, OnModuleInit {
  readonly provider = 'shopify' as const;

  constructor(private readonly registry: ProviderRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /**
   * Smallest real Shopify API call that proves the token actually works:
   * GET shop.json, the same request Shopify's own docs use as the
   * canonical "is this token valid" check.
   */
  async verifyConnection(credentials: Record<string, string>): Promise<boolean> {
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
      throw new ProviderError(
        `Could not reach Shopify: ${error instanceof Error ? error.message : 'unknown network error'}.`,
      );
    }

    // 4xx (401 bad token, 404 unknown shop domain, ...) is the merchant having
    // entered something wrong — an ordinary rejection, not a thrown error.
    if (response.status >= 400 && response.status < 500) {
      return false;
    }
    if (!response.ok) {
      throw new ProviderError(`Shopify connection check failed with status ${response.status}.`);
    }

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
   * Verifies Shopify's `X-Shopify-Hmac-Sha256` header: base64(HMAC-SHA256(
   * rawBody, secret)) — the exact check Shopify's own webhook docs specify.
   * `secret` is whatever the merchant pasted as `credentials.webhookSecret`
   * (their custom app's API secret key, or the signing secret shown when
   * they create the webhook subscription — either way, a value only
   * Shopify and BRAYN should know, not something BRAYN issues or derives).
   */
  verifyWebhookSignature(rawBody: string, headers: Record<string, string>, secret: string): boolean {
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

  /**
   * Shopify puts the event topic and delivery id in headers, not the
   * body — unlike the REST list endpoints, a webhook payload is just the
   * bare resource. Only the create/update topics for customers, products,
   * orders, and fulfillments are recognized (doc 21 — "process only
   * relevant events"); everything else, including deletes, is out of this
   * part's scope.
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
            : {
                resource,
                data: { ...normalizeFulfillment(raw as ShopifyFulfillment), orderExternalId: String((raw as ShopifyFulfillment).order_id) },
              };

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

/** Recognized webhook topics → the commerce resource they normalize to (doc 21 — "process only relevant events"). */
const SHOPIFY_WEBHOOK_TOPICS: Record<string, 'customer' | 'product' | 'order' | 'fulfillment'> = {
  'customers/create': 'customer',
  'customers/update': 'customer',
  'products/create': 'product',
  'products/update': 'product',
  'orders/create': 'order',
  'orders/updated': 'order',
  'fulfillments/create': 'fulfillment',
  'fulfillments/update': 'fulfillment',
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
