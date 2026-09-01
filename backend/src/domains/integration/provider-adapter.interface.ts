import type { IntegrationProvider } from './dto/connect-integration.schema';

/**
 * Contract every provider integration implements (doc 20 — Common
 * Integration Contract). Provider-specific API clients, payload shapes and
 * quirks stay behind this boundary so core BRAYN domains never depend on
 * them directly (doc 06 — Provider Isolation, doc 03 rule 11).
 *
 * Phase 3 defines and tests this contract in isolation. Concrete adapters
 * (Shopify, WooCommerce, …) and the sync/import/webhook framework parts
 * that call through it land in later parts — see doc 19 Phase 3/4.
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
}
