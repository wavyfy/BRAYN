import type { IntegrationProvider } from './dto/connect-integration.schema';

/** A webhook payload the adapter recognized and normalized (doc 21 — External → Internal Conversion). */
export interface ParsedWebhookEvent {
  /** Provider-supplied event/delivery id, used for webhook deduplication (doc 21 — Webhook Idempotency). */
  externalEventId: string;
  eventType: string;
  payload: unknown;
}

/**
 * Contract every provider integration implements (doc 20 — Common
 * Integration Contract). Provider-specific API clients, payload shapes and
 * quirks stay behind this boundary so core BRAYN domains never depend on
 * them directly (doc 06 — Provider Isolation, doc 03 rule 11).
 *
 * Phase 3 defines and tests this contract in isolation. Concrete adapters
 * (Shopify, WooCommerce, …) that implement it land in Phase 4 — see doc 19.
 */
export interface ProviderAdapter {
  readonly provider: IntegrationProvider;

  /**
   * Verifies that `credentials` still authenticate against the provider
   * (doc 20 — Connection verification). Must not throw for an ordinary
   * "credentials rejected" outcome — that is a `false` result, not an
   * exception; reserve throwing for unexpected/unclassified failures.
   */
  verifyConnection(credentials: Record<string, string>): Promise<boolean>;

  /**
   * Webhook support (doc 21 — Webhook Contract). Optional: "supports
   * where applicable" — a provider without webhooks implements neither.
   */

  /** Verifies the delivery's authenticity (e.g. an HMAC signature header) using this integration's stored secret. */
  verifyWebhookSignature?(rawBody: string, headers: Record<string, string>, secret: string): boolean;

  /** Parses and normalizes a verified payload. Returns null for a delivery type BRAYN doesn't act on (doc 21 — "process only relevant events"). */
  parseWebhookEvent?(rawBody: string): ParsedWebhookEvent | null;
}
