import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from './provider-registry.service';
import type { ProviderAdapter } from './provider-adapter.interface';

function makeAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    provider: 'shopify',
    verifyConnection: vi.fn(async () => true),
    ...overrides,
  };
}

describe('ProviderRegistry', () => {
  it('has() is false and get() throws before any adapter is registered', () => {
    const registry = new ProviderRegistry();

    expect(registry.has('shopify')).toBe(false);
    expect(() => registry.get('shopify')).toThrow(/No adapter is registered/);
  });

  it('registers an adapter and returns it via get()', () => {
    const registry = new ProviderRegistry();
    const adapter = makeAdapter();

    registry.register(adapter);

    expect(registry.has('shopify')).toBe(true);
    expect(registry.get('shopify')).toBe(adapter);
  });

  it('keeps adapters for different providers independent', () => {
    const registry = new ProviderRegistry();
    const shopify = makeAdapter({ provider: 'shopify' });
    const woocommerce = makeAdapter({ provider: 'woocommerce' });

    registry.register(shopify);
    registry.register(woocommerce);

    expect(registry.get('shopify')).toBe(shopify);
    expect(registry.get('woocommerce')).toBe(woocommerce);
    expect(registry.has('whatsapp')).toBe(false);
  });

  it('throws when registering a second adapter for the same provider', () => {
    const registry = new ProviderRegistry();
    registry.register(makeAdapter());

    expect(() => registry.register(makeAdapter())).toThrow(/already registered/);
  });

  it('get() error is a ProviderError (surfaces as 502, not a silent failure)', () => {
    const registry = new ProviderRegistry();

    expect(() => registry.get('shopify')).toThrow(expect.objectContaining({ code: 'PROVIDER_ERROR' }));
  });
});
