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

/** Minimal Admin GraphQL query for verifyConnection() — only `id` is consumed, proving the token works without over-fetching. */
const SHOPIFY_VERIFY_CONNECTION_QUERY = `{ shop { id } }`;

/**
 * fetchCustomers() (slice 2 of the REST→GraphQL migration) — requests
 * exactly the fields normalizeCustomer() consumes, nothing more. `query`
 * is Shopify's search-syntax filter (doc 06/20 — Incremental
 * Synchronization); omitted entirely for an initial import that wants
 * everything.
 */
const SHOPIFY_CUSTOMERS_QUERY = `
  query FetchCustomers($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          email
          firstName
          lastName
          phone
          updatedAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * fetchProducts() (slice 4) — requests exactly the fields normalizeProduct()
 * consumes for the product and each variant. `variantsFirst` bounds the
 * variants page embedded inline with each product; a product with more
 * variants than that is finished off by SHOPIFY_PRODUCT_VARIANTS_QUERY
 * (see ShopifyAdapter.collectAllProductVariants).
 */
const SHOPIFY_PRODUCTS_QUERY = `
  query FetchProducts($first: Int!, $after: String, $query: String, $variantsFirst: Int!) {
    products(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          title
          updatedAt
          variants(first: $variantsFirst) {
            edges {
              node {
                id
                sku
                price
                inventoryQuantity
                updatedAt
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** Continuation query for a single product's variants past the first embedded page — its own `after`/`hasNextPage`/`endCursor`, never the product connection's cursor. */
const SHOPIFY_PRODUCT_VARIANTS_QUERY = `
  query FetchProductVariants($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      variants(first: $first, after: $after) {
        edges {
          node {
            id
            sku
            price
            inventoryQuantity
            updatedAt
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

/**
 * fetchCollections() (slice 3) — Shopify's unified GraphQL `collections`
 * connection replaces REST's two separate custom_collections/
 * smart_collections endpoints (see the ShopifyGraphqlCollectionNode doc
 * comment). Requests exactly the fields normalizeCollection() consumes.
 */
const SHOPIFY_COLLECTIONS_QUERY = `
  query FetchCollections($first: Int!, $after: String, $query: String) {
    collections(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          title
          updatedAt
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * fetchOrders() (slice 5) — requests exactly the fields normalizeOrder()/
 * normalizeRefund()/normalizeFulfillment() consume. No order-level status
 * field is requested since NormalizedOrder never carried one (REST's
 * `financial_status`/`fulfillment_status` were never consumed either).
 *
 * REST's `status=any` (to include closed/cancelled orders, since REST's
 * own default excludes them) has no confirmed 1:1 GraphQL equivalent —
 * Shopify's reference documents `status:` search values as open/closed/
 * cancelled/not_closed, with no documented `any`. No status filter is
 * added here rather than guessing at unverified syntax; see fetchOrders'
 * doc comment for the real-provider verification this needs.
 */
const SHOPIFY_ORDERS_QUERY = `
  query FetchOrders(
    $first: Int!
    $after: String
    $query: String
    $lineItemsFirst: Int!
    $refundsFirst: Int!
    $refundLineItemsFirst: Int!
    $fulfillmentsFirst: Int!
  ) {
    orders(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          customer {
            id
          }
          totalPriceSet {
            shopMoney {
              amount
            }
          }
          updatedAt
          lineItems(first: $lineItemsFirst) {
            edges {
              node {
                id
                quantity
                variant {
                  id
                }
                originalUnitPriceSet {
                  shopMoney {
                    amount
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          refunds(first: $refundsFirst) {
            id
            note
            createdAt
            refundLineItems(first: $refundLineItemsFirst) {
              edges {
                node {
                  id
                  quantity
                  lineItem {
                    id
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
            transactions {
              status
              amountSet {
                shopMoney {
                  amount
                }
              }
            }
          }
          fulfillments(first: $fulfillmentsFirst) {
            id
            status
            shipmentStatus
            updatedAt
            trackingInfo {
              company
              number
              url
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** Continuation query for a single order's line items past the first embedded page — its own `after`/`hasNextPage`/`endCursor`, never the orders connection's cursor. Refunds/fulfillments have no continuation query — Shopify's schema gives them no cursor to continue from (see REFUNDS_PAGE_SIZE doc comment). */
const SHOPIFY_ORDER_LINE_ITEMS_QUERY = `
  query FetchOrderLineItems($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      lineItems(first: $first, after: $after) {
        edges {
          node {
            id
            quantity
            variant {
              id
            }
            originalUnitPriceSet {
              shopMoney {
                amount
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

/**
 * fetchCollects() (slice 6, final) — advances the outer collections walk
 * one collection at a time (`first: 1`). Only `id` is requested; nothing
 * else about a collection is needed to walk its membership (see
 * fetchCollects doc comment for why Shopify's schema forces this
 * traversal shape).
 */
const SHOPIFY_NEXT_COLLECTION_QUERY = `
  query FetchNextShopifyCollection($first: Int!, $after: String) {
    collections(first: $first, after: $after) {
      edges {
        node {
          id
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/** fetchCollects() (slice 6) — one page of a single collection's product membership. Only `id` is requested per product; there is nothing else to normalize into NormalizedCollect. */
const SHOPIFY_COLLECTION_PRODUCTS_QUERY = `
  query FetchCollectionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        edges {
          node {
            id
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

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
  category: '200' | '401' | '403' | '404' | 'other_4xx' | 'server_error' | 'network_error' | 'graphql_errors';
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

/**
 * Extracts a diagnostic message from a GraphQL Admin API response body's
 * top-level `errors` array (distinct from readShopifyErrorField's REST
 * `errors` shape, which is a string or a validation-style object, never an
 * array) — e.g. `{"errors":[{"message":"Throttled"}]}`. Never throws; an
 * unparseable/unexpected shape yields `null` so a malformed response is a
 * defensive `false`, not a crash.
 */
function extractGraphqlErrors(body: unknown): string | null {
  if (!body || typeof body !== 'object' || !('errors' in body)) {
    return null;
  }
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return null;
  }
  const messages = errors
    .map((entry) =>
      entry && typeof entry === 'object' && typeof (entry as { message?: unknown }).message === 'string'
        ? (entry as { message: string }).message
        : null,
    )
    .filter((message): message is string => message !== null);
  return messages.length > 0 ? messages.join('; ') : null;
}

const CUSTOMERS_PAGE_SIZE = 250;
const PRODUCTS_PAGE_SIZE = 250;
/** Page size for a product's nested variants connection, both the page embedded in the products query and every continuation page (doc 20 — a product can have more variants than fit in one page). */
const VARIANTS_PAGE_SIZE = 250;
const ORDERS_PAGE_SIZE = 250;
/** Page size for an order's nested line-items connection — same "embedded first page, continuation query past that" pattern as products' variants (see ShopifyAdapter.collectAllOrderLineItems). */
const LINE_ITEMS_PAGE_SIZE = 250;
/**
 * Order.refunds and Order.fulfillments are plain lists in Shopify's real
 * GraphQL schema (`[Refund!]!` / `[Fulfillment!]!`, `first` argument only)
 * — unlike lineItems, neither is a paginated connection, so there is no
 * `after`/cursor to continue past whatever `first` returns (verified
 * against shopify.dev's Order object reference before implementing this
 * slice, not assumed).
 */
const REFUNDS_PAGE_SIZE = 250;
const FULFILLMENTS_PAGE_SIZE = 250;
/**
 * Refund.refundLineItems IS a real connection (`RefundLineItemConnection!`),
 * a third nesting level under refunds. Bounded here by a generous `first`
 * with no continuation query implemented — a refund's line items can never
 * exceed the order's own line-item count, which is already bounded by
 * LINE_ITEMS_PAGE_SIZE/continuation, so a real order cannot exceed this in
 * practice. ponytail: no 4th-level continuation; revisit only if a
 * real-store order is ever observed with >250 distinct refunded line items
 * in one refund.
 */
const REFUND_LINE_ITEMS_PAGE_SIZE = 250;
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

/** Admin GraphQL API's `Customer` node shape — same underlying fields as ShopifyCustomer, GraphQL's own naming/typing. */
interface ShopifyGraphqlCustomerNode {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  updatedAt: string;
}

interface ShopifyGraphqlCustomersConnection {
  edges: { node: ShopifyGraphqlCustomerNode }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
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

/** Admin GraphQL API's `ProductVariant` node — REST embedded the full variants array with no pagination of its own; GraphQL nests it as its own connection (see fetchProducts doc comment). */
interface ShopifyGraphqlVariantNode {
  id: string;
  sku: string | null;
  price: string | null;
  inventoryQuantity: number | null;
  updatedAt: string;
}

interface ShopifyGraphqlVariantsConnection {
  edges: { node: ShopifyGraphqlVariantNode }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** Admin GraphQL API's `Product` node — only the fields normalizeProduct()/normalizeVariant equivalents actually consume; BRAYN does not currently read handle, description, vendor, productType, or status, so none are requested. */
interface ShopifyGraphqlProductNode {
  id: string;
  title: string;
  updatedAt: string;
  variants: ShopifyGraphqlVariantsConnection;
}

interface ShopifyGraphqlProductsConnection {
  edges: { node: ShopifyGraphqlProductNode }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
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

/**
 * Admin GraphQL API's unified `Collection` node — REST split this across
 * two resources (CustomCollection/SmartCollection) with no shared field
 * distinguishing which one a given collection was; ShopifyCollection above
 * (and NormalizedCollection downstream) never carried that distinction
 * either, since nothing past this adapter consumed it (see fetchCollections
 * doc comment). GraphQL's single `collections` connection is therefore a
 * straightforward simplification, not a behavior change requiring a
 * compatibility field.
 */
interface ShopifyGraphqlCollectionNode {
  id: string;
  title: string;
  updatedAt: string;
}

interface ShopifyGraphqlCollectionsConnection {
  edges: { node: ShopifyGraphqlCollectionNode }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * `id` is now a synthesized `${collectionNumericId}:${productNumericId}`
 * composite for GraphQL-sourced collects (see fetchCollects doc comment)
 * — Shopify's GraphQL API has no Collect/membership object or id at all
 * (verified against shopify.dev), so REST's own numeric `collect.id` has
 * no equivalent to preserve. `String(collect.id)` in normalizeCollect
 * stays correct either way (identity on an already-string value).
 */
interface ShopifyCollect {
  id: string;
  collection_id: number;
  product_id: number;
}

/** Minimal `{ id }`-only node/connection shape, reused for both "the next collection" and "one collection's products" GraphQL queries — neither needs any field beyond the GID (see fetchCollects doc comment). */
interface ShopifyGraphqlIdNode {
  id: string;
}

interface ShopifyGraphqlIdConnection {
  edges: { node: ShopifyGraphqlIdNode }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * Opaque compound cursor state for fetchCollects() (migration slice 6).
 * Unlike every other migrated method, Shopify's GraphQL API has no
 * top-level Collect resource to page through directly — membership can
 * only be reconstructed by walking every collection's `products`
 * connection (see fetchCollects doc comment for why this traversal
 * direction was chosen). A single opaque cursor must therefore encode
 * *two* independent positions at once:
 *
 * - `collectionsCursor`/`collectionsExhausted`: where the outer walk of
 *   collections is, so advancing to the next collection never restarts
 *   from the first one. `collectionsExhausted: true` is a distinct state
 *   from `collectionsCursor: null` — the latter means "haven't started
 *   walking collections yet" (the very first call), not "no more
 *   collections exist." Conflating the two would make the cursor
 *   restart the whole walk from collection #1 once the last collection's
 *   products are exhausted, silently re-emitting every membership link a
 *   second time.
 * - `currentCollectionId`/`productsCursor`: which collection is
 *   currently being walked and how far into its products connection,
 *   so resuming mid-collection continues that collection's own products
 *   page rather than skipping to the next collection early.
 */
interface ShopifyCollectsCursorState {
  collectionsCursor: string | null;
  collectionsExhausted: boolean;
  currentCollectionId: string | null;
  productsCursor: string | null;
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

/** Admin GraphQL API's nested money shape — every Shopify GraphQL money field returns this, never a bare string (unlike REST's `total_price`/`price`/`amount`). Only `shopMoney.amount` is read; `currencyCode`/`presentmentMoney` aren't requested since BRAYN doesn't currently consume a currency field. */
interface ShopifyGraphqlMoneyBag {
  shopMoney: { amount: string };
}

interface ShopifyGraphqlOrderLineItemNode {
  id: string;
  quantity: number;
  variant: { id: string } | null;
  /** REST's `line_items[].price` is documented as "price before discounts" — the GraphQL equivalent is `originalUnitPriceSet`, not `discountedUnitPriceSet` (see fetchOrders doc comment). */
  originalUnitPriceSet: ShopifyGraphqlMoneyBag | null;
}

interface ShopifyGraphqlOrderLineItemsConnection {
  edges: { node: ShopifyGraphqlOrderLineItemNode }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface ShopifyGraphqlRefundLineItemNode {
  id: string;
  quantity: number;
  lineItem: { id: string } | null;
}

interface ShopifyGraphqlRefundLineItemsConnection {
  edges: { node: ShopifyGraphqlRefundLineItemNode }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/** `status` is a GraphQL enum (e.g. `SUCCESS`) — lower-cased on conversion so normalizeRefund's existing `transaction.status === 'success'` REST-string check keeps matching (see graphqlTransactionToRestShape). */
interface ShopifyGraphqlOrderTransactionNode {
  status: string;
  amountSet: ShopifyGraphqlMoneyBag | null;
}

interface ShopifyGraphqlRefundNode {
  id: string;
  note: string | null;
  /** REST's `processed_at` has no exact GraphQL analog; `createdAt` is the closest documented field (see fetchOrders doc comment — flagged for real-provider verification). */
  createdAt: string;
  refundLineItems: ShopifyGraphqlRefundLineItemsConnection;
  transactions: ShopifyGraphqlOrderTransactionNode[];
}

/** Singular in the real schema (`ShipmentTrackingInfo`, not a list) — REST's flat tracking_company/number/url map directly, no list-to-single reduction needed. */
interface ShopifyGraphqlFulfillmentTrackingInfo {
  company: string | null;
  number: string | null;
  url: string | null;
}

interface ShopifyGraphqlOrderFulfillmentNode {
  id: string;
  status: string | null;
  shipmentStatus: string | null;
  updatedAt: string | null;
  trackingInfo: ShopifyGraphqlFulfillmentTrackingInfo | null;
}

interface ShopifyGraphqlOrderNode {
  id: string;
  customer: { id: string } | null;
  totalPriceSet: ShopifyGraphqlMoneyBag | null;
  updatedAt: string;
  lineItems: ShopifyGraphqlOrderLineItemsConnection;
  /** Plain list per Shopify's real schema, not a connection — see REFUNDS_PAGE_SIZE doc comment. */
  refunds: ShopifyGraphqlRefundNode[];
  /** Plain list per Shopify's real schema, not a connection — see FULFILLMENTS_PAGE_SIZE doc comment. */
  fulfillments: ShopifyGraphqlOrderFulfillmentNode[];
}

interface ShopifyGraphqlOrdersConnection {
  edges: { node: ShopifyGraphqlOrderNode }[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
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
   * Shared POST to Shopify's Admin GraphQL endpoint, used by every
   * resource-fetch method migrated off REST (fetchCustomers here, more to
   * follow) — not a second API-client abstraction, just the one place the
   * "fetch, reject non-2xx, reject a 200 carrying errors[], reject a
   * malformed body" sequence lives, mirroring what fetchPage() already
   * does for the REST methods. Credentials were already verified at
   * connect time (verifyConnection/OAuth callback) — same convention as
   * fetchPage(): any failure here is an infrastructure/auth problem and
   * always throws, never returns a partial/empty result to swallow.
   */
  private async graphqlRequest(
    credentials: Record<string, string>,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const { shopDomain, accessToken } = credentials;
    if (!SHOPIFY_DOMAIN_PATTERN.test(shopDomain)) {
      throw new ProviderError('Stored Shopify shop domain is invalid.');
    }

    let response: Response;
    try {
      response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (error) {
      throw new ProviderError(
        `Could not reach Shopify: ${error instanceof Error ? error.message : 'unknown network error'}.`,
      );
    }
    if (!response.ok) {
      throw new ProviderError(`Shopify GraphQL request failed with status ${response.status}.`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ProviderError('Shopify returned a malformed GraphQL response.');
    }

    const graphqlErrors = extractGraphqlErrors(body);
    if (graphqlErrors) {
      throw new ProviderError(`Shopify GraphQL request returned errors: ${graphqlErrors}`);
    }
    const data = (body as { data?: unknown } | null)?.data;
    if (!data || typeof data !== 'object') {
      throw new ProviderError('Shopify GraphQL response had no data.');
    }

    return data as Record<string, unknown>;
  }

  /**
   * Walks every remaining page of one product's variants connection (doc
   * 20 Shopify Phase 1 Data) — REST embedded the full variants array with
   * no pagination of its own, so a product isn't complete until every
   * variant page has been fetched, not just the first one embedded in
   * SHOPIFY_PRODUCTS_QUERY. Uses the variants connection's own
   * `after`/`hasNextPage`/`endCursor` via a per-product continuation
   * query (`product(id: ...)`) — never the outer products-connection
   * cursor. Any failure here (network, non-2xx, GraphQL errors[],
   * malformed shape) propagates as a thrown ProviderError from
   * graphqlRequest(), aborting the whole fetchProducts() page rather than
   * returning a product with a silently incomplete variant list.
   */
  private async collectAllProductVariants(
    credentials: Record<string, string>,
    product: ShopifyGraphqlProductNode,
  ): Promise<ShopifyGraphqlVariantNode[]> {
    const variants = product.variants.edges.map((edge) => edge.node);
    let pageInfo = product.variants.pageInfo;

    while (pageInfo.hasNextPage) {
      const data = await this.graphqlRequest(credentials, SHOPIFY_PRODUCT_VARIANTS_QUERY, {
        id: product.id,
        first: VARIANTS_PAGE_SIZE,
        after: pageInfo.endCursor,
      });
      const nextProduct = (data as { product?: { variants?: ShopifyGraphqlVariantsConnection } }).product;
      if (!nextProduct?.variants || !Array.isArray(nextProduct.variants.edges) || !nextProduct.variants.pageInfo) {
        throw new ProviderError('Shopify GraphQL product variants response had an unexpected shape.');
      }
      variants.push(...nextProduct.variants.edges.map((edge) => edge.node));
      pageInfo = nextProduct.variants.pageInfo;
    }

    return variants;
  }

  /**
   * Walks every remaining page of one order's line-items connection —
   * same pattern as collectAllProductVariants(), its own cursor, never
   * the outer orders-connection cursor. Any failure propagates as a
   * thrown ProviderError, aborting the whole fetchOrders() page rather
   * than returning an order with a silently incomplete line-item list.
   */
  private async collectAllOrderLineItems(
    credentials: Record<string, string>,
    order: ShopifyGraphqlOrderNode,
  ): Promise<ShopifyGraphqlOrderLineItemNode[]> {
    const lineItems = order.lineItems.edges.map((edge) => edge.node);
    let pageInfo = order.lineItems.pageInfo;

    while (pageInfo.hasNextPage) {
      const data = await this.graphqlRequest(credentials, SHOPIFY_ORDER_LINE_ITEMS_QUERY, {
        id: order.id,
        first: LINE_ITEMS_PAGE_SIZE,
        after: pageInfo.endCursor,
      });
      const nextOrder = (data as { order?: { lineItems?: ShopifyGraphqlOrderLineItemsConnection } }).order;
      if (!nextOrder?.lineItems || !Array.isArray(nextOrder.lineItems.edges) || !nextOrder.lineItems.pageInfo) {
        throw new ProviderError('Shopify GraphQL order line items response had an unexpected shape.');
      }
      lineItems.push(...nextOrder.lineItems.edges.map((edge) => edge.node));
      pageInfo = nextOrder.lineItems.pageInfo;
    }

    return lineItems;
  }

  /**
   * Advances fetchCollects()'s outer collections walk by exactly one
   * collection, starting after `collectionsCursor` (`null` = the very
   * first collection). Fetches one collection at a time (`first: 1`)
   * rather than a full page, so resuming never needs to remember "which
   * collection within an already-fetched batch was next" — every
   * "advance" step is a fresh, self-contained single-collection fetch.
   * Returns `null` when there is no next collection at all (collections
   * exhausted or the shop has none).
   */
  private async advanceToNextShopifyCollection(
    credentials: Record<string, string>,
    collectionsCursor: string | null,
  ): Promise<{ collectionId: string; nextCollectionsCursor: string | null; exhausted: boolean } | null> {
    const data = await this.graphqlRequest(credentials, SHOPIFY_NEXT_COLLECTION_QUERY, {
      first: 1,
      after: collectionsCursor,
    });
    const collections = (data as { collections?: ShopifyGraphqlIdConnection }).collections;
    if (!collections || !Array.isArray(collections.edges) || !collections.pageInfo) {
      throw new ProviderError('Shopify GraphQL collections response had an unexpected shape.');
    }
    if (collections.edges.length === 0) {
      return null;
    }

    return {
      collectionId: collections.edges[0].node.id,
      nextCollectionsCursor: collections.pageInfo.hasNextPage ? (collections.pageInfo.endCursor ?? null) : null,
      exhausted: !collections.pageInfo.hasNextPage,
    };
  }

  /**
   * Smallest real Shopify API call that proves the token actually works:
   * the Admin GraphQL API's `shop { id }` query — Shopify's own
   * canonical "is this token valid" check, now GraphQL-backed (App Store
   * requires new public apps to use the GraphQL Admin API, not REST; see
   * the REST→GraphQL migration audit). `fetchPage()` and the other five
   * resource methods are unchanged and still REST — this is migration
   * slice 1 of 6, `verifyConnection()` only.
   *
   * A GraphQL request can fail two structurally different ways: an
   * HTTP-level failure (401/403/404/5xx/network — same categories as the
   * old REST call, since Shopify's GraphQL endpoint returns the same
   * status codes for an invalid token or unknown shop domain) or an
   * HTTP-200 response whose body carries a top-level `errors[]` array
   * instead of `data.shop` (e.g. a throttled or malformed query) — the
   * REST endpoint had no equivalent of this second failure mode, since a
   * 200 there always meant success.
   *
   * `onDiagnostic` (doc 20 Part 20) is an optional, fingerprint-safe hook
   * — a status-code/GraphQL-error *category* plus the non-sensitive
   * `X-Shopify-API-Version` response header, never the body/token/domain.
   * Existing callers (`connectViaClientCredentials`) don't pass it, so this
   * parameter changes nothing about their behavior; `ShopifyOAuthService.
   * handleCallback` passes one so its own failure log can distinguish
   * *why* verification failed instead of a single opaque boolean, without
   * ever logging a credential or response body.
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
      response = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ query: SHOPIFY_VERIFY_CONNECTION_QUERY }),
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

    // HTTP 200 does not mean success for GraphQL — the body can still carry
    // a top-level `errors[]` (e.g. throttled, or the query itself rejected),
    // and a malformed/unexpected body is a defensive rejection, not a crash.
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      onDiagnostic?.({ category: 'graphql_errors', apiVersionHeader, shopifyError: null });
      return false;
    }

    const graphqlErrors = extractGraphqlErrors(body);
    if (graphqlErrors) {
      onDiagnostic?.({ category: 'graphql_errors', apiVersionHeader, shopifyError: graphqlErrors });
      return false;
    }

    const shopId = (body as { data?: { shop?: { id?: unknown } } }).data?.shop?.id;
    if (typeof shopId !== 'string') {
      onDiagnostic?.({ category: 'graphql_errors', apiVersionHeader, shopifyError: null });
      return false;
    }

    onDiagnostic?.({ category: '200', apiVersionHeader, shopifyError: null });
    return true;
  }

  /**
   * One page of the merchant's customers (doc 20 — Initial Import:
   * pagination), GraphQL-backed (migration slice 2). `cursor`, when
   * present, is Shopify's opaque `endCursor` — never a URL, so there is
   * nothing to SSRF-validate the way `fetchPage()`'s REST Link-header
   * cursor needs `assertCursorMatchesShop` for: every call here always
   * hits this shop's own fixed GraphQL endpoint regardless of the cursor
   * value.
   *
   * Unlike REST (where Shopify's `Link` header carries the original
   * `updated_at_min` forward automatically), a GraphQL cursor does not
   * encode the search filter that produced it — `options.updatedAtMin`
   * must be resent as the `query` argument on every page, not just the
   * first. Every caller (ImportProcessorService, SyncProcessorService,
   * ReconciliationProcessorService) already passes the same `options`
   * object on every iteration of its pagination loop, so this is a
   * behavior change forced by the pagination model itself, not a
   * regression.
   *
   * Reuses normalizeCustomer() unchanged by converting the GraphQL node
   * into the same shape the REST/webhook path already produces — the
   * `id` field is Shopify's GID (e.g. `gid://shopify/Customer/123`), not
   * the plain numeric REST id, so it's converted back to the bare numeric
   * id here specifically so externalId stays identical to what a
   * REST-sourced or webhook-sourced customer record already produces
   * (doc 06 — a provider's external id must be stable across every
   * ingestion path, or the same real customer would import as a
   * duplicate).
   */
  async fetchCustomers(credentials: Record<string, string>, cursor?: string, options?: FetchOptions): Promise<CustomerPage> {
    const variables: Record<string, unknown> = { first: CUSTOMERS_PAGE_SIZE };
    if (cursor) {
      variables.after = cursor;
    }
    const queryFilter = shopifyUpdatedAtQueryFilter(options);
    if (queryFilter) {
      variables.query = queryFilter;
    }

    const data = await this.graphqlRequest(credentials, SHOPIFY_CUSTOMERS_QUERY, variables);
    const customers = (data as { customers?: ShopifyGraphqlCustomersConnection }).customers;
    if (!customers || !Array.isArray(customers.edges) || !customers.pageInfo) {
      throw new ProviderError('Shopify GraphQL customers response had an unexpected shape.');
    }

    return {
      customers: customers.edges.map((edge) => normalizeCustomer(graphqlCustomerToRestShape(edge.node))),
      nextCursor: customers.pageInfo.hasNextPage ? (customers.pageInfo.endCursor ?? null) : null,
    };
  }

  /**
   * One page of the merchant's products and their variants (doc 20
   * Shopify Phase 1 Data), GraphQL-backed (migration slice 4). Two
   * independent pagination levels: the outer products connection (this
   * method's own `cursor`/`after`/`hasNextPage`/`endCursor`) and, for
   * each product, its nested variants connection — fully exhausted via
   * `collectAllProductVariants()` before that product is considered
   * complete, since GraphQL nests variants behind their own connection
   * instead of REST's single embedded array. The two cursors are never
   * interchanged.
   *
   * Same GID→numeric-id conversion, `query`-resent-on-every-page
   * filtering, and cursor-is-opaque-not-a-URL conventions as
   * fetchCustomers()/fetchCollections() — see those methods' doc
   * comments.
   */
  async fetchProducts(credentials: Record<string, string>, cursor?: string, options?: FetchOptions): Promise<ProductPage> {
    const variables: Record<string, unknown> = { first: PRODUCTS_PAGE_SIZE, variantsFirst: VARIANTS_PAGE_SIZE };
    if (cursor) {
      variables.after = cursor;
    }
    const queryFilter = shopifyUpdatedAtQueryFilter(options);
    if (queryFilter) {
      variables.query = queryFilter;
    }

    const data = await this.graphqlRequest(credentials, SHOPIFY_PRODUCTS_QUERY, variables);
    const products = (data as { products?: ShopifyGraphqlProductsConnection }).products;
    if (!products || !Array.isArray(products.edges) || !products.pageInfo) {
      throw new ProviderError('Shopify GraphQL products response had an unexpected shape.');
    }

    const normalized: NormalizedProduct[] = [];
    for (const edge of products.edges) {
      if (!edge.node.variants || !Array.isArray(edge.node.variants.edges) || !edge.node.variants.pageInfo) {
        throw new ProviderError('Shopify GraphQL product variants response had an unexpected shape.');
      }
      const variantNodes = await this.collectAllProductVariants(credentials, edge.node);
      normalized.push(normalizeProduct(graphqlProductToRestShape(edge.node, variantNodes)));
    }

    return {
      products: normalized,
      nextCursor: products.pageInfo.hasNextPage ? (products.pageInfo.endCursor ?? null) : null,
    };
  }

  /**
   * One page of the merchant's orders, with their line items, refunds,
   * and fulfillments (doc 20 Shopify Phase 1 Data), GraphQL-backed
   * (migration slice 5). Four candidate cursor levels, but only two are
   * real: the outer orders connection and, per order, its line-items
   * connection — both walked with their own independent cursor via
   * `collectAllOrderLineItems()`, same pattern as fetchProducts()'s
   * variants. Refunds and fulfillments are NOT connections in Shopify's
   * actual schema (`Order.refunds`/`Order.fulfillments` are plain lists,
   * `first` argument only, no `after`/pageInfo — verified against
   * shopify.dev before writing this query, not assumed) — there is no
   * cursor to continue past whatever REFUNDS_PAGE_SIZE/
   * FULFILLMENTS_PAGE_SIZE returns.
   *
   * REST's `status=any` (include closed/cancelled orders) has no
   * confirmed GraphQL search-syntax equivalent — see SHOPIFY_ORDERS_QUERY's
   * doc comment. No status filter is sent; **this needs real-provider
   * acceptance testing to confirm the GraphQL `orders` connection's
   * default status scope actually matches REST's `status=any` behavior**,
   * since getting this wrong would silently narrow which orders import.
   *
   * Money: REST's flat `total_price`/line-item `price`/refund-transaction
   * `amount` all come back as `{ shopMoney: { amount } }` in GraphQL —
   * unwrapped to the same flat string in graphqlOrderToRestShape() etc.,
   * never leaking the nested shape into NormalizedOrder. `currencyCode`
   * isn't requested since no currency field is currently consumed.
   */
  async fetchOrders(credentials: Record<string, string>, cursor?: string, options?: FetchOptions): Promise<OrderPage> {
    const variables: Record<string, unknown> = {
      first: ORDERS_PAGE_SIZE,
      lineItemsFirst: LINE_ITEMS_PAGE_SIZE,
      refundsFirst: REFUNDS_PAGE_SIZE,
      refundLineItemsFirst: REFUND_LINE_ITEMS_PAGE_SIZE,
      fulfillmentsFirst: FULFILLMENTS_PAGE_SIZE,
    };
    if (cursor) {
      variables.after = cursor;
    }
    const queryFilter = shopifyUpdatedAtQueryFilter(options);
    if (queryFilter) {
      variables.query = queryFilter;
    }

    const data = await this.graphqlRequest(credentials, SHOPIFY_ORDERS_QUERY, variables);
    const orders = (data as { orders?: ShopifyGraphqlOrdersConnection }).orders;
    if (!orders || !Array.isArray(orders.edges) || !orders.pageInfo) {
      throw new ProviderError('Shopify GraphQL orders response had an unexpected shape.');
    }

    const normalized: NormalizedOrder[] = [];
    for (const edge of orders.edges) {
      assertShopifyOrderNodeShape(edge.node);
      const lineItemNodes = await this.collectAllOrderLineItems(credentials, edge.node);
      normalized.push(normalizeOrder(graphqlOrderToRestShape(edge.node, lineItemNodes)));
    }

    return {
      orders: normalized,
      nextCursor: orders.pageInfo.hasNextPage ? (orders.pageInfo.endCursor ?? null) : null,
    };
  }

  /**
   * One page of the merchant's collections (doc 20 Shopify Phase 1 Data),
   * GraphQL-backed (migration slice 3). REST split this across two
   * separate resources — CustomCollection and SmartCollection, with no
   * unified list endpoint — which the old implementation walked as two
   * phases behind a `custom:`/`smart:` cursor prefix. That split was pure
   * pagination plumbing: `ShopifyCollection`/`NormalizedCollection` never
   * carried a type/kind field, so nothing downstream ever distinguished a
   * custom collection from a smart one. GraphQL's single `collections`
   * connection replaces both endpoints and the two-phase cursor logic
   * outright — a simplification, not a behavior change requiring a
   * compatibility shim (see ShopifyGraphqlCollectionNode doc comment).
   *
   * Same GID→numeric-id and cursor-is-opaque-not-a-URL conventions as
   * fetchCustomers() (slice 2) — see that method's doc comment.
   */
  async fetchCollections(credentials: Record<string, string>, cursor?: string, options?: FetchOptions): Promise<CollectionPage> {
    const variables: Record<string, unknown> = { first: COLLECTIONS_PAGE_SIZE };
    if (cursor) {
      variables.after = cursor;
    }
    const queryFilter = shopifyUpdatedAtQueryFilter(options);
    if (queryFilter) {
      variables.query = queryFilter;
    }

    const data = await this.graphqlRequest(credentials, SHOPIFY_COLLECTIONS_QUERY, variables);
    const collections = (data as { collections?: ShopifyGraphqlCollectionsConnection }).collections;
    if (!collections || !Array.isArray(collections.edges) || !collections.pageInfo) {
      throw new ProviderError('Shopify GraphQL collections response had an unexpected shape.');
    }

    return {
      collections: collections.edges.map((edge) => normalizeCollection(graphqlCollectionToRestShape(edge.node))),
      nextCursor: collections.pageInfo.hasNextPage ? (collections.pageInfo.endCursor ?? null) : null,
    };
  }

  /**
   * Product-collection membership (Shopify's `Collect` resource in REST),
   * GraphQL-backed (migration slice 6, final). Shopify's GraphQL API has
   * no top-level Collect resource and no Collect/membership id at all
   * (verified against shopify.dev before implementing this slice) — the
   * only way to reconstruct membership is to walk every collection's
   * `products` connection (collection→products, not product→collections:
   * both `importCollects()`/`reconcileCollects()` already run after
   * collections are imported, and a shop typically has far fewer
   * collections than products).
   *
   * Because there is no single flat resource to page through, `cursor`
   * is an opaque *compound* state (see ShopifyCollectsCursorState/
   * decodeShopifyCollectsCursor) tracking both the outer collections walk
   * and the current collection's own products-connection position. A call
   * that starts between collections does one "advance to the next
   * collection" round trip *plus* one "fetch that collection's first
   * products page" round trip; a call resuming mid-collection does only
   * the second. Either way it advances through at most one collection per
   * call — a collection with zero products still gets its own (empty)
   * page rather than silently skipping ahead to the next one within the
   * same call.
   *
   * `externalId` is synthesized per membership pair (see
   * graphqlCollectToRestShape) since Shopify gives nothing else to key
   * on; this is what commerce_collection_products' idempotency key
   * actually needs, and is deterministic — repeated fetches of the same
   * real collection/product pair always produce the same externalId, so
   * upserts stay idempotent exactly as before.
   */
  async fetchCollects(credentials: Record<string, string>, cursor?: string): Promise<CollectPage> {
    const state = decodeShopifyCollectsCursor(cursor);
    let { collectionsCursor, collectionsExhausted, currentCollectionId, productsCursor } = state;

    if (!currentCollectionId) {
      if (collectionsExhausted) {
        return { collects: [], nextCursor: null };
      }
      const advanced = await this.advanceToNextShopifyCollection(credentials, collectionsCursor);
      if (!advanced) {
        return { collects: [], nextCursor: null };
      }
      currentCollectionId = advanced.collectionId;
      collectionsCursor = advanced.nextCollectionsCursor;
      collectionsExhausted = advanced.exhausted;
      productsCursor = null;
    }

    const data = await this.graphqlRequest(credentials, SHOPIFY_COLLECTION_PRODUCTS_QUERY, {
      id: currentCollectionId,
      first: COLLECTS_PAGE_SIZE,
      after: productsCursor,
    });
    const collection = (data as { collection?: { products?: ShopifyGraphqlIdConnection } }).collection;
    if (!collection?.products || !Array.isArray(collection.products.edges) || !collection.products.pageInfo) {
      throw new ProviderError('Shopify GraphQL collection products response had an unexpected shape.');
    }

    const collectionNumericId = shopifyGidToNumericId(currentCollectionId);
    const collects = collection.products.edges.map((edge) =>
      normalizeCollect(graphqlCollectToRestShape(collectionNumericId, shopifyGidToNumericId(edge.node.id))),
    );

    if (collection.products.pageInfo.hasNextPage) {
      // Stay on this collection next call — resume its products where this page left off.
      return {
        collects,
        nextCursor: encodeShopifyCollectsCursor({
          collectionsCursor,
          collectionsExhausted,
          currentCollectionId,
          productsCursor: collection.products.pageInfo.endCursor,
        }),
      };
    }

    // This collection's products are exhausted.
    if (collectionsExhausted) {
      return { collects, nextCursor: null };
    }
    // Advance to the next collection on the *next* call — keeps this call to one GraphQL round trip.
    return {
      collects,
      nextCursor: encodeShopifyCollectsCursor({
        collectionsCursor,
        collectionsExhausted: false,
        currentCollectionId: null,
        productsCursor: null,
      }),
    };
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

/** Shopify's search-syntax equivalent of REST's `updated_at_min` param — quoted, since the DSL tokenizes on the colons in an ISO timestamp otherwise. */
function shopifyUpdatedAtQueryFilter(options?: FetchOptions): string | undefined {
  return options?.updatedAtMin ? `updated_at:>='${options.updatedAtMin.toISOString()}'` : undefined;
}

/** A GraphQL id is `gid://shopify/<Type>/<numericId>` — extracts the trailing numeric id so it matches the plain numeric id REST/webhook payloads already produce for the same record (see fetchCustomers doc comment). */
function shopifyGidToNumericId(gid: string): number {
  const match = /\/(\d+)$/.exec(gid);
  if (!match) {
    throw new ProviderError('Shopify returned an unrecognized GraphQL id format.');
  }
  return Number(match[1]);
}

/** Converts a GraphQL customer node into the REST payload shape so normalizeCustomer() — shared with the REST/webhook path — needs no GraphQL-specific branch. */
function graphqlCustomerToRestShape(node: ShopifyGraphqlCustomerNode): ShopifyCustomer {
  return {
    id: shopifyGidToNumericId(node.id),
    email: node.email,
    first_name: node.firstName,
    last_name: node.lastName,
    phone: node.phone,
    updated_at: node.updatedAt,
  };
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

/** Converts a GraphQL variant node into the REST payload shape (see fetchProducts doc comment for the GID->numeric-id rationale). */
function graphqlVariantToRestShape(node: ShopifyGraphqlVariantNode): ShopifyVariant {
  return {
    id: shopifyGidToNumericId(node.id),
    sku: node.sku,
    price: node.price,
    inventory_quantity: node.inventoryQuantity,
    updated_at: node.updatedAt,
  };
}

/** Converts a GraphQL product node plus its fully-collected variant nodes into the REST payload shape so normalizeProduct() — shared with the webhook path — needs no GraphQL-specific branch. */
function graphqlProductToRestShape(node: ShopifyGraphqlProductNode, variantNodes: ShopifyGraphqlVariantNode[]): ShopifyProduct {
  return {
    id: shopifyGidToNumericId(node.id),
    title: node.title,
    updated_at: node.updatedAt,
    variants: variantNodes.map(graphqlVariantToRestShape),
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

/**
 * Fails closed on any malformed nested shape in a GraphQL order node —
 * line items, refunds, or fulfillments — before fetchOrders() starts
 * walking line-item continuation pages, so a malformed nested connection
 * never produces a silently incomplete order (see fetchOrders doc
 * comment). Line items' own pageInfo is checked here too even though
 * collectAllOrderLineItems() re-checks it on each continuation page —
 * this catches a malformed *first* page before any continuation request
 * is even attempted.
 */
function assertShopifyOrderNodeShape(node: ShopifyGraphqlOrderNode): void {
  if (!node.lineItems || !Array.isArray(node.lineItems.edges) || !node.lineItems.pageInfo) {
    throw new ProviderError('Shopify GraphQL order line items response had an unexpected shape.');
  }
  if (!Array.isArray(node.refunds)) {
    throw new ProviderError('Shopify GraphQL order refunds response had an unexpected shape.');
  }
  for (const refund of node.refunds) {
    if (!refund.refundLineItems || !Array.isArray(refund.refundLineItems.edges) || !Array.isArray(refund.transactions)) {
      throw new ProviderError('Shopify GraphQL order refund response had an unexpected shape.');
    }
  }
  if (!Array.isArray(node.fulfillments)) {
    throw new ProviderError('Shopify GraphQL order fulfillments response had an unexpected shape.');
  }
}

/** Converts a GraphQL order line-item node into the REST payload shape (see fetchOrders doc comment for the GID->numeric-id and money-mapping rationale). */
function graphqlLineItemToRestShape(node: ShopifyGraphqlOrderLineItemNode): ShopifyLineItem {
  return {
    id: shopifyGidToNumericId(node.id),
    variant_id: node.variant ? shopifyGidToNumericId(node.variant.id) : null,
    quantity: node.quantity,
    price: node.originalUnitPriceSet?.shopMoney.amount ?? null,
  };
}

function graphqlRefundLineItemToRestShape(node: ShopifyGraphqlRefundLineItemNode): ShopifyRefundLineItem {
  return {
    id: shopifyGidToNumericId(node.id),
    line_item_id: node.lineItem ? shopifyGidToNumericId(node.lineItem.id) : null,
    quantity: node.quantity,
  };
}

/** `status` arrives as an uppercase GraphQL enum (e.g. `SUCCESS`) — lower-cased so normalizeRefund's existing `transaction.status === 'success'` string check keeps matching REST/webhook-sourced data. */
function graphqlTransactionToRestShape(node: ShopifyGraphqlOrderTransactionNode): ShopifyRefundTransaction {
  return {
    amount: node.amountSet?.shopMoney.amount ?? null,
    status: node.status ? node.status.toLowerCase() : null,
  };
}

function graphqlRefundToRestShape(node: ShopifyGraphqlRefundNode): ShopifyRefund {
  return {
    id: shopifyGidToNumericId(node.id),
    note: node.note,
    processed_at: node.createdAt,
    refund_line_items: node.refundLineItems.edges.map((edge) => graphqlRefundLineItemToRestShape(edge.node)),
    transactions: node.transactions.map(graphqlTransactionToRestShape),
  };
}

/** `status`/`shipmentStatus` arrive as uppercase GraphQL enums (e.g. `IN_TRANSIT`) — lower-cased to match the REST/webhook lowercase string convention normalizeFulfillment already expects. `orderNumericId` fills ShopifyFulfillment.order_id, which normalizeFulfillment doesn't read for an order-embedded fetch (only the standalone webhook path does) but the REST shape requires. */
function graphqlFulfillmentToRestShape(node: ShopifyGraphqlOrderFulfillmentNode, orderNumericId: number): ShopifyFulfillment {
  return {
    id: shopifyGidToNumericId(node.id),
    order_id: orderNumericId,
    status: node.status ? node.status.toLowerCase() : null,
    tracking_company: node.trackingInfo?.company ?? null,
    tracking_number: node.trackingInfo?.number ?? null,
    tracking_url: node.trackingInfo?.url ?? null,
    shipment_status: node.shipmentStatus ? node.shipmentStatus.toLowerCase() : null,
    updated_at: node.updatedAt,
  };
}

/** Converts a GraphQL order node plus its fully-collected line-item nodes into the REST payload shape so normalizeOrder() — shared with the webhook path — needs no GraphQL-specific branch. */
function graphqlOrderToRestShape(node: ShopifyGraphqlOrderNode, lineItemNodes: ShopifyGraphqlOrderLineItemNode[]): ShopifyOrder {
  const orderNumericId = shopifyGidToNumericId(node.id);
  return {
    id: orderNumericId,
    customer: node.customer ? { id: shopifyGidToNumericId(node.customer.id) } : null,
    total_price: node.totalPriceSet?.shopMoney.amount ?? null,
    updated_at: node.updatedAt,
    line_items: lineItemNodes.map(graphqlLineItemToRestShape),
    refunds: node.refunds.map(graphqlRefundToRestShape),
    fulfillments: node.fulfillments.map((fulfillment) => graphqlFulfillmentToRestShape(fulfillment, orderNumericId)),
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

/** Converts a GraphQL collection node into the REST payload shape so normalizeCollection() — shared with the webhook path — needs no GraphQL-specific branch (see fetchCollections doc comment for the GID->numeric-id rationale). */
function graphqlCollectionToRestShape(node: ShopifyGraphqlCollectionNode): ShopifyCollection {
  return {
    id: shopifyGidToNumericId(node.id),
    title: node.title,
    updated_at: node.updatedAt,
  };
}

/** Shared with fetchCollections and the collections/* webhooks (same bare shape either way). */
function normalizeCollection(collection: ShopifyCollection): NormalizedCollection {
  return {
    externalId: String(collection.id),
    title: collection.title,
    sourceUpdatedAt: new Date(collection.updated_at),
  };
}

/**
 * Shopify's GraphQL API exposes no Collect/membership object or id
 * (verified against shopify.dev, not assumed) — so the membership's
 * `externalId` is synthesized here as a deterministic composite of both
 * sides' numeric ids, which is exactly the stable idempotency key
 * `commerce_collection_products`' unique index needs. Never attempts to
 * preserve or derive the old REST `collect.id` — there is nothing on the
 * GraphQL side to derive it from.
 */
function graphqlCollectToRestShape(collectionNumericId: number, productNumericId: number): ShopifyCollect {
  return {
    id: `${collectionNumericId}:${productNumericId}`,
    collection_id: collectionNumericId,
    product_id: productNumericId,
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

/**
 * Decodes fetchCollects()'s opaque compound cursor (base64 JSON — never a
 * URL, so unlike REST's Link-header cursor there is nothing for a cursor
 * to redirect the fetch to; the GraphQL endpoint fetchCollects() calls is
 * always the shop's own fixed `graphql.json`, regardless of cursor
 * content). `undefined` (the very first call) decodes to the "start from
 * collection #1" state. Any other malformed/tampered value — invalid
 * base64, invalid JSON, wrong shape, wrong field types — fails safely by
 * throwing rather than silently restarting or skipping the traversal.
 */
function decodeShopifyCollectsCursor(cursor: string | undefined): ShopifyCollectsCursorState {
  if (!cursor) {
    return { collectionsCursor: null, collectionsExhausted: false, currentCollectionId: null, productsCursor: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
  } catch {
    throw new ProviderError('Received an invalid Shopify collects pagination cursor.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ProviderError('Received an invalid Shopify collects pagination cursor.');
  }
  const { collectionsCursor, collectionsExhausted, currentCollectionId, productsCursor } = parsed as Record<string, unknown>;
  const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
  if (
    !isNullableString(collectionsCursor) ||
    typeof collectionsExhausted !== 'boolean' ||
    !isNullableString(currentCollectionId) ||
    !isNullableString(productsCursor)
  ) {
    throw new ProviderError('Received an invalid Shopify collects pagination cursor.');
  }

  return { collectionsCursor, collectionsExhausted, currentCollectionId, productsCursor };
}

/** Encodes fetchCollects()' cursor state — see decodeShopifyCollectsCursor. */
function encodeShopifyCollectsCursor(state: ShopifyCollectsCursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}
