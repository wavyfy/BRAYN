import { describe, expect, it, vi } from 'vitest';
import { ImportProcessorService } from './import-processor.service';
import type { DomainEvent } from '../../common/events/domain-event';
import type { CustomerService } from '../commerce/customer.service';
import type { ProductService } from '../commerce/product.service';
import type { OrderService } from '../commerce/order.service';
import type { CollectionService } from '../commerce/collection.service';
import type { ImportRunService } from './import-run.service';
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
  return {
    upsertMany: vi.fn(async (_ws, _int, _p, collections) => collections.length),
    upsertCollects: vi.fn(async (_ws, _int, _p, collects) => collects.length),
  } as unknown as CollectionService;
}

function makeEvent(overrides: Partial<DomainEvent<{ provider: 'shopify'; runId: string }>> = {}) {
  return {
    id: 'evt_1',
    type: 'integration.import.requested',
    version: 1,
    workspaceId: 'ws_1',
    entityId: 'int_1',
    occurredAt: '2026-01-01T00:00:00Z',
    payload: { provider: 'shopify', runId: 'run_1' },
    ...overrides,
  } as DomainEvent<{ provider: 'shopify'; runId: string }>;
}

const credentials = { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_x' };

describe('ImportProcessorService', () => {
  it('paginates through all pages, upserts customers, and completes the run', async () => {
    const page1: CustomerPage = {
      customers: [
        { externalId: '1', email: 'a@x.com', firstName: 'A', lastName: 'A', phone: null, sourceUpdatedAt: null },
      ],
      nextCursor: 'cursor_2',
    };
    const page2: CustomerPage = {
      customers: [
        { externalId: '2', email: 'b@x.com', firstName: 'B', lastName: 'B', phone: null, sourceUpdatedAt: null },
      ],
      nextCursor: null,
    };
    const fetchCustomers = vi.fn(async (_creds: unknown, cursor?: string) => (cursor ? page2 : page1));
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const importRunService = {
      recordProgress: vi.fn(async () => undefined),
      completeImportRun: vi.fn(async () => undefined),
      failImportRun: vi.fn(async () => undefined),
    } as unknown as ImportRunService;
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = { upsertMany: vi.fn(async (_ws, _int, _p, customers) => customers.length) } as unknown as CustomerService;
    const processor = new ImportProcessorService(
      registry,
      importRunService,
      integrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
      makeCollectionService(),
    );

    await processor.handleImportRequested(makeEvent());

    expect(fetchCustomers).toHaveBeenCalledTimes(2);
    expect(fetchCustomers).toHaveBeenNthCalledWith(1, credentials, undefined);
    expect(fetchCustomers).toHaveBeenNthCalledWith(2, credentials, 'cursor_2');
    expect(customerService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', page1.customers);
    expect(customerService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', page2.customers);
    expect(importRunService.recordProgress).toHaveBeenNthCalledWith(1, 'run_1', {
      recordsImported: 1,
      recordsFailed: 0,
      cursor: 'cursor_2',
    });
    expect(importRunService.recordProgress).toHaveBeenNthCalledWith(2, 'run_1', {
      recordsImported: 2,
      recordsFailed: 0,
      cursor: undefined,
    });
    expect(importRunService.completeImportRun).toHaveBeenCalledWith('run_1');
    expect(importRunService.failImportRun).not.toHaveBeenCalled();
  });

  it('fails the run without fetching when no credentials are stored', async () => {
    const registry = { get: vi.fn() } as unknown as ProviderRegistry;
    const importRunService = { failImportRun: vi.fn(async () => undefined) } as unknown as ImportRunService;
    const integrationService = { getCredentials: vi.fn(async () => null) } as unknown as IntegrationService;
    const customerService = { upsertMany: vi.fn() } as unknown as CustomerService;
    const processor = new ImportProcessorService(
      registry,
      importRunService,
      integrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
      makeCollectionService(),
    );

    await processor.handleImportRequested(makeEvent());

    expect(importRunService.failImportRun).toHaveBeenCalledWith('run_1', expect.stringContaining('No credentials'));
    expect(registry.get).not.toHaveBeenCalled();
  });

  it('fails the run when a page fetch throws', async () => {
    const fetchCustomers = vi.fn(async () => {
      throw new Error('Shopify customer fetch failed with status 500.');
    });
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const importRunService = {
      recordProgress: vi.fn(async () => undefined),
      completeImportRun: vi.fn(async () => undefined),
      failImportRun: vi.fn(async () => undefined),
    } as unknown as ImportRunService;
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = { upsertMany: vi.fn() } as unknown as CustomerService;
    const processor = new ImportProcessorService(
      registry,
      importRunService,
      integrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
      makeCollectionService(),
    );

    await processor.handleImportRequested(makeEvent());

    expect(importRunService.failImportRun).toHaveBeenCalledWith(
      'run_1',
      'Shopify customer fetch failed with status 500.',
    );
    expect(importRunService.completeImportRun).not.toHaveBeenCalled();
  });

  it('counts the whole page as failed when storing it throws, but keeps paginating', async () => {
    const page1: CustomerPage = {
      customers: [{ externalId: '1', email: null, firstName: null, lastName: null, phone: null, sourceUpdatedAt: null }],
      nextCursor: null,
    };
    const fetchCustomers = vi.fn(async () => page1);
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const importRunService = {
      recordProgress: vi.fn(async () => undefined),
      completeImportRun: vi.fn(async () => undefined),
      failImportRun: vi.fn(async () => undefined),
    } as unknown as ImportRunService;
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = {
      upsertMany: vi.fn(async () => {
        throw new Error('constraint violation');
      }),
    } as unknown as CustomerService;
    const processor = new ImportProcessorService(
      registry,
      importRunService,
      integrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
      makeCollectionService(),
    );

    await processor.handleImportRequested(makeEvent());

    expect(importRunService.recordProgress).toHaveBeenCalledWith('run_1', {
      recordsImported: 0,
      recordsFailed: 1,
      cursor: undefined,
    });
    expect(importRunService.completeImportRun).toHaveBeenCalledWith('run_1');
  });

  it('imports customers then products in the same run, with cumulative progress', async () => {
    const customerPage: CustomerPage = {
      customers: [{ externalId: '1', email: null, firstName: null, lastName: null, phone: null, sourceUpdatedAt: null }],
      nextCursor: null,
    };
    const productPage: ProductPage = {
      products: [{ externalId: '55', title: 'Tee', sourceUpdatedAt: null, variants: [] }],
      nextCursor: null,
    };
    const fetchCustomers = vi.fn(async () => customerPage);
    const fetchProducts = vi.fn(async () => productPage);
    const registry = {
      get: vi.fn(() => ({ fetchCustomers, fetchProducts }) as unknown as ProviderAdapter),
    } as unknown as ProviderRegistry;
    const importRunService = {
      recordProgress: vi.fn(async () => undefined),
      completeImportRun: vi.fn(async () => undefined),
      failImportRun: vi.fn(async () => undefined),
    } as unknown as ImportRunService;
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = { upsertMany: vi.fn(async () => 1) } as unknown as CustomerService;
    const productService = makeProductService();
    const processor = new ImportProcessorService(
      registry,
      importRunService,
      integrationService,
      customerService,
      productService,
      makeOrderService(),
      makeCollectionService(),
    );

    await processor.handleImportRequested(makeEvent());

    expect(fetchCustomers).toHaveBeenCalledTimes(1);
    expect(fetchProducts).toHaveBeenCalledTimes(1);
    expect(productService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', productPage.products);
    // Second (product) page's progress carries the customer count forward cumulatively.
    expect(importRunService.recordProgress).toHaveBeenNthCalledWith(2, 'run_1', {
      recordsImported: 2,
      recordsFailed: 0,
      cursor: undefined,
    });
    expect(importRunService.completeImportRun).toHaveBeenCalledWith('run_1');
  });

  it('skips product import entirely when the adapter does not support it', async () => {
    const customerPage: CustomerPage = { customers: [], nextCursor: null };
    const fetchCustomers = vi.fn(async () => customerPage);
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const importRunService = {
      recordProgress: vi.fn(async () => undefined),
      completeImportRun: vi.fn(async () => undefined),
      failImportRun: vi.fn(async () => undefined),
    } as unknown as ImportRunService;
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = { upsertMany: vi.fn(async () => 0) } as unknown as CustomerService;
    const productService = makeProductService();
    const processor = new ImportProcessorService(
      registry,
      importRunService,
      integrationService,
      customerService,
      productService,
      makeOrderService(),
      makeCollectionService(),
    );

    await processor.handleImportRequested(makeEvent());

    expect(productService.upsertMany).not.toHaveBeenCalled();
    expect(importRunService.completeImportRun).toHaveBeenCalledWith('run_1');
  });

  it('imports orders last, after customers and products, with cumulative progress', async () => {
    const customerPage: CustomerPage = {
      customers: [{ externalId: '1', email: null, firstName: null, lastName: null, phone: null, sourceUpdatedAt: null }],
      nextCursor: null,
    };
    const productPage: ProductPage = {
      products: [{ externalId: '55', title: 'Tee', sourceUpdatedAt: null, variants: [] }],
      nextCursor: null,
    };
    const orderPage: OrderPage = {
      orders: [{ externalId: '900', customerExternalId: '1', totalPrice: '19.99', sourceUpdatedAt: null, lineItems: [], refunds: [], fulfillments: [] }],
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
    const importRunService = {
      recordProgress: vi.fn(async () => undefined),
      completeImportRun: vi.fn(async () => undefined),
      failImportRun: vi.fn(async () => undefined),
    } as unknown as ImportRunService;
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = { upsertMany: vi.fn(async () => 1) } as unknown as CustomerService;
    const productService = makeProductService();
    const orderService = makeOrderService();
    const processor = new ImportProcessorService(
      registry,
      importRunService,
      integrationService,
      customerService,
      productService,
      orderService,
      makeCollectionService(),
    );

    await processor.handleImportRequested(makeEvent());

    expect(callOrder).toEqual(['customers', 'products', 'orders']);
    expect(orderService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', orderPage.orders);
    // Third (order) page's progress carries the customer+product count forward cumulatively.
    expect(importRunService.recordProgress).toHaveBeenNthCalledWith(3, 'run_1', {
      recordsImported: 3,
      recordsFailed: 0,
      cursor: undefined,
    });
    expect(importRunService.completeImportRun).toHaveBeenCalledWith('run_1');
  });

  it('skips order import entirely when the adapter does not support it', async () => {
    const customerPage: CustomerPage = { customers: [], nextCursor: null };
    const fetchCustomers = vi.fn(async () => customerPage);
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const importRunService = {
      recordProgress: vi.fn(async () => undefined),
      completeImportRun: vi.fn(async () => undefined),
      failImportRun: vi.fn(async () => undefined),
    } as unknown as ImportRunService;
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = { upsertMany: vi.fn(async () => 0) } as unknown as CustomerService;
    const orderService = makeOrderService();
    const processor = new ImportProcessorService(
      registry,
      importRunService,
      integrationService,
      customerService,
      makeProductService(),
      orderService,
      makeCollectionService(),
    );

    await processor.handleImportRequested(makeEvent());

    expect(orderService.upsertMany).not.toHaveBeenCalled();
    expect(importRunService.completeImportRun).toHaveBeenCalledWith('run_1');
  });

  it('imports collections, then collects, last of all — after orders', async () => {
    const callOrder: string[] = [];
    const fetchCustomers = vi.fn(async () => {
      callOrder.push('customers');
      return { customers: [], nextCursor: null } as CustomerPage;
    });
    const fetchProducts = vi.fn(async () => {
      callOrder.push('products');
      return { products: [], nextCursor: null } as ProductPage;
    });
    const fetchOrders = vi.fn(async () => {
      callOrder.push('orders');
      return { orders: [], nextCursor: null } as OrderPage;
    });
    const collectionPage = { collections: [{ externalId: '10', title: 'Summer Sale', sourceUpdatedAt: null }], nextCursor: null };
    const collectPage = { collects: [{ externalId: '500', collectionExternalId: '10', productExternalId: '55' }], nextCursor: null };
    const fetchCollections = vi.fn(async () => {
      callOrder.push('collections');
      return collectionPage;
    });
    const fetchCollects = vi.fn(async () => {
      callOrder.push('collects');
      return collectPage;
    });
    const registry = {
      get: vi.fn(() => ({ fetchCustomers, fetchProducts, fetchOrders, fetchCollections, fetchCollects }) as unknown as ProviderAdapter),
    } as unknown as ProviderRegistry;
    const importRunService = {
      recordProgress: vi.fn(async () => undefined),
      completeImportRun: vi.fn(async () => undefined),
      failImportRun: vi.fn(async () => undefined),
    } as unknown as ImportRunService;
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const collectionService = makeCollectionService();
    const processor = new ImportProcessorService(
      registry,
      importRunService,
      integrationService,
      { upsertMany: vi.fn(async () => 0) } as unknown as CustomerService,
      makeProductService(),
      makeOrderService(),
      collectionService,
    );

    await processor.handleImportRequested(makeEvent());

    expect(callOrder).toEqual(['customers', 'products', 'orders', 'collections', 'collects']);
    expect(collectionService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', collectionPage.collections);
    expect(collectionService.upsertCollects).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', collectPage.collects);
    expect(importRunService.completeImportRun).toHaveBeenCalledWith('run_1');
  });

  it('skips collections/collects import entirely when the adapter does not support them', async () => {
    const fetchCustomers = vi.fn(async () => ({ customers: [], nextCursor: null }) as CustomerPage);
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const importRunService = {
      recordProgress: vi.fn(async () => undefined),
      completeImportRun: vi.fn(async () => undefined),
      failImportRun: vi.fn(async () => undefined),
    } as unknown as ImportRunService;
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const collectionService = makeCollectionService();
    const processor = new ImportProcessorService(
      registry,
      importRunService,
      integrationService,
      { upsertMany: vi.fn(async () => 0) } as unknown as CustomerService,
      makeProductService(),
      makeOrderService(),
      collectionService,
    );

    await processor.handleImportRequested(makeEvent());

    expect(collectionService.upsertMany).not.toHaveBeenCalled();
    expect(collectionService.upsertCollects).not.toHaveBeenCalled();
    expect(importRunService.completeImportRun).toHaveBeenCalledWith('run_1');
  });
});
