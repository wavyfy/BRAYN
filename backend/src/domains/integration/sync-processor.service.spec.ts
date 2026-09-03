import { describe, expect, it, vi } from 'vitest';
import { SyncProcessorService } from './sync-processor.service';
import type { DomainEvent } from '../../common/events/domain-event';
import type { CustomerService } from '../commerce/customer.service';
import type { ProductService } from '../commerce/product.service';
import type { OrderService } from '../commerce/order.service';
import type { CollectionService } from '../commerce/collection.service';
import type { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import type { IntegrationService } from './integration.service';
import type { ProviderRegistry } from './provider-registry.service';
import type { CustomerPage, OrderPage, ProductPage, ProviderAdapter } from './provider-adapter.interface';

function makeProductService(): ProductService {
  return { upsertMany: vi.fn(async (_ws, _int, _p, products) => ({ productsWritten: products.length, variantsWritten: 0 })) } as unknown as ProductService;
}

function makeOrderService(): OrderService {
  return { upsertMany: vi.fn(async (_ws, _int, _p, orders) => ({ ordersWritten: orders.length, lineItemsWritten: 0 })) } as unknown as OrderService;
}

function makeCollectionService(): CollectionService {
  return { upsertMany: vi.fn(async (_ws, _int, _p, collections) => collections.length) } as unknown as CollectionService;
}

function makeIdentityResolutionService(): IdentityResolutionService {
  return { resolveMany: vi.fn(async () => undefined) } as unknown as IdentityResolutionService;
}

function makeIntegrationService(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    getCredentials: vi.fn(async () => ({ shopDomain: 'acme.myshopify.com', accessToken: 'shpat_x' })),
    completeSync: vi.fn(async () => undefined),
    failSync: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<DomainEvent<{ provider: 'shopify'; updatedAtMin: string }>> = {}) {
  return {
    id: 'evt_1',
    type: 'integration.sync.requested',
    version: 1,
    workspaceId: 'ws_1',
    entityId: 'int_1',
    occurredAt: '2026-01-01T00:00:00Z',
    payload: { provider: 'shopify', updatedAtMin: '2026-01-01T00:00:00.000Z' },
    ...overrides,
  } as DomainEvent<{ provider: 'shopify'; updatedAtMin: string }>;
}

describe('SyncProcessorService', () => {
  it('passes updatedAtMin to the adapter and applies each page via upsertMany, then completes the sync', async () => {
    const page: CustomerPage = {
      customers: [{ externalId: '1', email: 'a@x.com', firstName: 'A', lastName: 'A', phone: null, sourceUpdatedAt: new Date() }],
      nextCursor: null,
    };
    const fetchCustomers = vi.fn(async () => page);
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const integrationService = makeIntegrationService();
    const customerService = { upsertMany: vi.fn(async () => 1) } as unknown as CustomerService;
    const identityResolutionService = makeIdentityResolutionService();
    const processor = new SyncProcessorService(
      registry,
      integrationService as unknown as IntegrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
      makeCollectionService(),
      identityResolutionService,
    );

    await processor.handleSyncRequested(makeEvent());

    expect(fetchCustomers).toHaveBeenCalledWith(
      { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_x' },
      undefined,
      { updatedAtMin: new Date('2026-01-01T00:00:00.000Z') },
    );
    expect(customerService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', page.customers);
    expect(identityResolutionService.resolveMany).toHaveBeenCalledWith('ws_1', 'shopify', page.customers.map((c) => c.externalId));
    expect(integrationService.completeSync).toHaveBeenCalledWith('ws_1', 'shopify');
    expect(integrationService.failSync).not.toHaveBeenCalled();
  });

  it('paginates a resource across multiple pages, passing the same updatedAtMin each time', async () => {
    const page1: CustomerPage = {
      customers: [{ externalId: '1', email: null, firstName: null, lastName: null, phone: null, sourceUpdatedAt: null }],
      nextCursor: 'cursor_2',
    };
    const page2: CustomerPage = {
      customers: [{ externalId: '2', email: null, firstName: null, lastName: null, phone: null, sourceUpdatedAt: null }],
      nextCursor: null,
    };
    const fetchCustomers = vi.fn(async (_creds: unknown, cursor?: string) => (cursor ? page2 : page1));
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const integrationService = makeIntegrationService();
    const customerService = { upsertMany: vi.fn(async () => 1) } as unknown as CustomerService;
    const processor = new SyncProcessorService(
      registry,
      integrationService as unknown as IntegrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
      makeCollectionService(),
      makeIdentityResolutionService(),
    );

    await processor.handleSyncRequested(makeEvent());

    expect(fetchCustomers).toHaveBeenCalledTimes(2);
    expect(fetchCustomers).toHaveBeenNthCalledWith(2, expect.anything(), 'cursor_2', { updatedAtMin: new Date('2026-01-01T00:00:00.000Z') });
    expect(customerService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', page1.customers);
    expect(customerService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', page2.customers);
    expect(integrationService.completeSync).toHaveBeenCalledWith('ws_1', 'shopify');
  });

  it('syncs customers, then products, then orders in the same pass', async () => {
    const customerPage: CustomerPage = { customers: [], nextCursor: null };
    const productPage: ProductPage = { products: [{ externalId: '55', title: 'Tee', sourceUpdatedAt: null, variants: [] }], nextCursor: null };
    const orderPage: OrderPage = {
      orders: [{ externalId: '900', customerExternalId: null, totalPrice: '19.99', sourceUpdatedAt: null, lineItems: [], refunds: [], fulfillments: [] }],
      nextCursor: null,
    };
    const callOrder: string[] = [];
    const fetchCustomers = vi.fn(async () => {
      callOrder.push('customers');
      return customerPage;
    });
    const fetchProducts = vi.fn(async () => {
      callOrder.push('products');
      return productPage;
    });
    const fetchOrders = vi.fn(async () => {
      callOrder.push('orders');
      return orderPage;
    });
    const registry = {
      get: vi.fn(() => ({ fetchCustomers, fetchProducts, fetchOrders }) as unknown as ProviderAdapter),
    } as unknown as ProviderRegistry;
    const integrationService = makeIntegrationService();
    const productService = makeProductService();
    const orderService = makeOrderService();
    const processor = new SyncProcessorService(
      registry,
      integrationService as unknown as IntegrationService,
      { upsertMany: vi.fn(async () => 0) } as unknown as CustomerService,
      productService,
      orderService,
      makeCollectionService(),
      makeIdentityResolutionService(),
    );

    await processor.handleSyncRequested(makeEvent());

    expect(callOrder).toEqual(['customers', 'products', 'orders']);
    expect(productService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', productPage.products);
    expect(orderService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', orderPage.orders);
    expect(integrationService.completeSync).toHaveBeenCalledWith('ws_1', 'shopify');
  });

  it('skips product/order sync entirely when the adapter does not support them', async () => {
    const fetchCustomers = vi.fn(async () => ({ customers: [], nextCursor: null }) as CustomerPage);
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const integrationService = makeIntegrationService();
    const productService = makeProductService();
    const orderService = makeOrderService();
    const processor = new SyncProcessorService(
      registry,
      integrationService as unknown as IntegrationService,
      { upsertMany: vi.fn(async () => 0) } as unknown as CustomerService,
      productService,
      orderService,
      makeCollectionService(),
      makeIdentityResolutionService(),
    );

    await processor.handleSyncRequested(makeEvent());

    expect(productService.upsertMany).not.toHaveBeenCalled();
    expect(orderService.upsertMany).not.toHaveBeenCalled();
    expect(integrationService.completeSync).toHaveBeenCalledWith('ws_1', 'shopify');
  });

  it('syncs collections (with updatedAtMin) but never collects — no updated_at field or webhook to key an incremental fetch off', async () => {
    const fetchCustomers = vi.fn(async () => ({ customers: [], nextCursor: null }) as CustomerPage);
    const collectionPage = { collections: [{ externalId: '10', title: 'Summer Sale', sourceUpdatedAt: null }], nextCursor: null };
    const fetchCollections = vi.fn(async () => collectionPage);
    const fetchCollects = vi.fn();
    const registry = {
      get: vi.fn(() => ({ fetchCustomers, fetchCollections, fetchCollects }) as unknown as ProviderAdapter),
    } as unknown as ProviderRegistry;
    const integrationService = makeIntegrationService();
    const collectionService = makeCollectionService();
    const processor = new SyncProcessorService(
      registry,
      integrationService as unknown as IntegrationService,
      { upsertMany: vi.fn(async () => 0) } as unknown as CustomerService,
      makeProductService(),
      makeOrderService(),
      collectionService,
      makeIdentityResolutionService(),
    );

    await processor.handleSyncRequested(makeEvent());

    expect(fetchCollections).toHaveBeenCalledWith(
      { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_x' },
      undefined,
      { updatedAtMin: new Date('2026-01-01T00:00:00.000Z') },
    );
    expect(collectionService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', collectionPage.collections);
    expect(fetchCollects).not.toHaveBeenCalled();
    expect(integrationService.completeSync).toHaveBeenCalledWith('ws_1', 'shopify');
  });

  it('fails the sync without fetching when no credentials are stored', async () => {
    const registry = { get: vi.fn() } as unknown as ProviderRegistry;
    const integrationService = makeIntegrationService({ getCredentials: vi.fn(async () => null) });
    const processor = new SyncProcessorService(
      registry,
      integrationService as unknown as IntegrationService,
      { upsertMany: vi.fn() } as unknown as CustomerService,
      makeProductService(),
      makeOrderService(),
      makeCollectionService(),
      makeIdentityResolutionService(),
    );

    await processor.handleSyncRequested(makeEvent());

    expect(integrationService.failSync).toHaveBeenCalledWith('ws_1', 'shopify', expect.stringContaining('No credentials'));
    expect(registry.get).not.toHaveBeenCalled();
  });

  it('fails the whole sync (no partial tolerance) when a page fetch throws', async () => {
    const fetchCustomers = vi.fn(async () => {
      throw new Error('Shopify customer fetch failed with status 500.');
    });
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const integrationService = makeIntegrationService();
    const processor = new SyncProcessorService(
      registry,
      integrationService as unknown as IntegrationService,
      { upsertMany: vi.fn() } as unknown as CustomerService,
      makeProductService(),
      makeOrderService(),
      makeCollectionService(),
      makeIdentityResolutionService(),
    );

    await processor.handleSyncRequested(makeEvent());

    expect(integrationService.failSync).toHaveBeenCalledWith('ws_1', 'shopify', 'Shopify customer fetch failed with status 500.');
    expect(integrationService.completeSync).not.toHaveBeenCalled();
  });

  it('fails the whole sync when an upsert throws mid-page, unlike ImportProcessorService', async () => {
    const page: CustomerPage = {
      customers: [{ externalId: '1', email: null, firstName: null, lastName: null, phone: null, sourceUpdatedAt: null }],
      nextCursor: null,
    };
    const fetchCustomers = vi.fn(async () => page);
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const integrationService = makeIntegrationService();
    const customerService = {
      upsertMany: vi.fn(async () => {
        throw new Error('constraint violation');
      }),
    } as unknown as CustomerService;
    const processor = new SyncProcessorService(
      registry,
      integrationService as unknown as IntegrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
      makeCollectionService(),
      makeIdentityResolutionService(),
    );

    await processor.handleSyncRequested(makeEvent());

    expect(integrationService.failSync).toHaveBeenCalledWith('ws_1', 'shopify', 'constraint violation');
    expect(integrationService.completeSync).not.toHaveBeenCalled();
  });

  it('does nothing when workspaceId/entityId are missing from the event envelope', async () => {
    const registry = { get: vi.fn() } as unknown as ProviderRegistry;
    const integrationService = makeIntegrationService();
    const processor = new SyncProcessorService(
      registry,
      integrationService as unknown as IntegrationService,
      { upsertMany: vi.fn() } as unknown as CustomerService,
      makeProductService(),
      makeOrderService(),
      makeCollectionService(),
      makeIdentityResolutionService(),
    );

    await processor.handleSyncRequested(makeEvent({ workspaceId: undefined, entityId: undefined }));

    expect(integrationService.getCredentials).not.toHaveBeenCalled();
    expect(registry.get).not.toHaveBeenCalled();
  });
});
