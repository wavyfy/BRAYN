import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ProviderError } from '../../../../common/errors/app-error';
import { ProviderRegistry } from '../../provider-registry.service';
import type { CustomerPage, ProviderAdapter } from '../../provider-adapter.interface';

const SHOPIFY_API_VERSION = '2024-10';
const CUSTOMERS_PAGE_SIZE = 250;

interface ShopifyCustomer {
  id: number;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  updated_at: string;
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
    if (!shopDomain || !accessToken) {
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
  async fetchCustomers(credentials: Record<string, string>, cursor?: string): Promise<CustomerPage> {
    const { shopDomain, accessToken } = credentials;
    const url = cursor ?? `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/customers.json?limit=${CUSTOMERS_PAGE_SIZE}`;

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
      throw new ProviderError(`Shopify customer fetch failed with status ${response.status}.`);
    }

    const body = (await response.json()) as { customers: ShopifyCustomer[] };
    const customers = body.customers.map((customer) => ({
      externalId: String(customer.id),
      email: customer.email,
      firstName: customer.first_name,
      lastName: customer.last_name,
      phone: customer.phone,
      sourceUpdatedAt: new Date(customer.updated_at),
    }));

    return { customers, nextCursor: parseNextCursor(response.headers.get('link')) };
  }
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
