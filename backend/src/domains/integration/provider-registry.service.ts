import { Injectable } from '@nestjs/common';
import { ProviderError } from '../../common/errors/app-error';
import type { IntegrationProvider } from './dto/connect-integration.schema';
import type { ProviderAdapter } from './provider-adapter.interface';

/**
 * Looks up the concrete adapter for a provider (doc 20 — Provider
 * abstraction). Empty until Phase 4 registers real adapters (Shopify,
 * WooCommerce, …) on module init; no adapters are registered in Phase 3.
 */
@Injectable()
export class ProviderRegistry {
  private readonly adapters = new Map<IntegrationProvider, ProviderAdapter>();

  /** Throws if an adapter is already registered for this provider — a double registration is a startup bug, not a runtime condition to silently overwrite. */
  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.provider)) {
      throw new Error(`A provider adapter is already registered for "${adapter.provider}".`);
    }
    this.adapters.set(adapter.provider, adapter);
  }

  has(provider: IntegrationProvider): boolean {
    return this.adapters.has(provider);
  }

  get(provider: IntegrationProvider): ProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new ProviderError(`No adapter is registered for provider "${provider}".`);
    }
    return adapter;
  }
}
