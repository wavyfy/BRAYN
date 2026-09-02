import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ProviderError } from '../../../../common/errors/app-error';
import { ProviderRegistry } from '../../provider-registry.service';
import type { ProviderAdapter } from '../../provider-adapter.interface';

const WC_API_PATH = 'wp-json/wc/v3';

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
 * This part covers connection/authentication only — fetch-family and
 * webhook methods land in later parts (doc 19 Phase 4 per-provider checklist).
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

    let url: URL;
    try {
      url = new URL(storeUrl);
    } catch {
      // A malformed URL is the merchant having entered something wrong — an
      // ordinary rejection, not a thrown error.
      return false;
    }
    if (url.protocol !== 'https:' || isPrivateOrLoopbackHost(url.hostname)) {
      return false;
    }

    const requestUrl = new URL(`${trimTrailingSlash(url.pathname)}/${WC_API_PATH}/customers?per_page=1`, url);
    const basicAuth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    let response: Response;
    try {
      response = await fetch(requestUrl, { headers: { Authorization: `Basic ${basicAuth}` } });
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
