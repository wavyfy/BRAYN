import { describe, expect, it, vi } from 'vitest';
import { ReconciliationProcessorService } from './reconciliation-processor.service';
import type { DomainEvent } from '../../common/events/domain-event';
import type { CustomerService } from '../commerce/customer.service';
import type { ProductService } from '../commerce/product.service';
import type { OrderService } from '../commerce/order.service';
import type { ReconciliationRunService } from './reconciliation-run.service';
import type { IntegrationService } from './integration.service';
import type { ProviderRegistry } from './provider-registry.service';
import type { CustomerPage, OrderPage, ProductPage, ProviderAdapter } from './provider-adapter.interface';

function makeReconciliationRunService() {
  return {
    recordProgress: vi.fn(async () => undefined),
    completeReconciliationRun: vi.fn(async () => undefined),
    failReconciliationRun: vi.fn(async () => undefined),
  };
}

function makeProductService(): ProductService {
  return {
    findExistingUpdatedAt: vi.fn(async () => new Map()),
    upsertMany: vi.fn(async (_ws, _int, _p, products) => ({ productsWritten: products.length, variantsWritten: 0 })),
  } as unknown as ProductService;
}

function makeOrderService(): OrderService {
  return {
    findExistingUpdatedAt: vi.fn(async () => new Map()),
    upsertMany: vi.fn(async (_ws, _int, _p, orders) => ({ ordersWritten: orders.length, lineItemsWritten: 0 })),
  } as unknown as OrderService;
}

function makeEvent(overrides: Partial<DomainEvent<{ provider: 'shopify'; runId: string }>> = {}) {
  return {
    id: 'evt_1',
    type: 'integration.reconciliation.requested',
    version: 1,
    workspaceId: 'ws_1',
    entityId: 'int_1',
    occurredAt: '2026-01-01T00:00:00Z',
    payload: { provider: 'shopify', runId: 'run_1' },
    ...overrides,
  } as DomainEvent<{ provider: 'shopify'; runId: string }>;
}

const credentials = { shopDomain: 'acme.myshopify.com', accessToken: 'shpat_x' };

describe('ReconciliationProcessorService', () => {
  it('detects a missing record (not in BRAYN yet) and repairs it via upsert', async () => {
    const page: CustomerPage = {
      customers: [{ externalId: '1', email: 'a@x.com', firstName: 'A', lastName: 'A', phone: null, sourceUpdatedAt: new Date('2026-01-02T00:00:00Z') }],
      nextCursor: null,
    };
    const fetchCustomers = vi.fn(async () => page);
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const reconciliationRunService = makeReconciliationRunService();
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = {
      findExistingUpdatedAt: vi.fn(async () => new Map()),
      upsertMany: vi.fn(async () => 1),
    } as unknown as CustomerService;
    const processor = new ReconciliationProcessorService(
      registry,
      reconciliationRunService as unknown as ReconciliationRunService,
      integrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
    );

    await processor.handleReconciliationRequested(makeEvent());

    expect(customerService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', page.customers);
    expect(reconciliationRunService.recordProgress).toHaveBeenCalledWith('run_1', {
      recordsChecked: 1,
      discrepanciesFound: 1,
      discrepanciesRepaired: 1,
    });
    expect(reconciliationRunService.completeReconciliationRun).toHaveBeenCalledWith('run_1');
  });

  it('detects a changed record (newer sourceUpdatedAt than what BRAYN has) and repairs it', async () => {
    const page: CustomerPage = {
      customers: [{ externalId: '1', email: 'a@x.com', firstName: 'A', lastName: 'A', phone: null, sourceUpdatedAt: new Date('2026-01-02T00:00:00Z') }],
      nextCursor: null,
    };
    const fetchCustomers = vi.fn(async () => page);
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const reconciliationRunService = makeReconciliationRunService();
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = {
      findExistingUpdatedAt: vi.fn(async () => new Map([['1', new Date('2026-01-01T00:00:00Z')]])),
      upsertMany: vi.fn(async () => 1),
    } as unknown as CustomerService;
    const processor = new ReconciliationProcessorService(
      registry,
      reconciliationRunService as unknown as ReconciliationRunService,
      integrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
    );

    await processor.handleReconciliationRequested(makeEvent());

    expect(reconciliationRunService.recordProgress).toHaveBeenCalledWith('run_1', {
      recordsChecked: 1,
      discrepanciesFound: 1,
      discrepanciesRepaired: 1,
    });
  });

  it('does not count a record as a discrepancy when its sourceUpdatedAt matches what BRAYN already has', async () => {
    const sameTimestamp = new Date('2026-01-01T00:00:00Z');
    const page: CustomerPage = {
      customers: [{ externalId: '1', email: 'a@x.com', firstName: 'A', lastName: 'A', phone: null, sourceUpdatedAt: sameTimestamp }],
      nextCursor: null,
    };
    const fetchCustomers = vi.fn(async () => page);
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const reconciliationRunService = makeReconciliationRunService();
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = {
      findExistingUpdatedAt: vi.fn(async () => new Map([['1', sameTimestamp]])),
      upsertMany: vi.fn(async () => 1),
    } as unknown as CustomerService;
    const processor = new ReconciliationProcessorService(
      registry,
      reconciliationRunService as unknown as ReconciliationRunService,
      integrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
    );

    await processor.handleReconciliationRequested(makeEvent());

    expect(reconciliationRunService.recordProgress).toHaveBeenCalledWith('run_1', {
      recordsChecked: 1,
      discrepanciesFound: 0,
      discrepanciesRepaired: 0,
    });
  });

  it('fails the run without fetching when no credentials are stored', async () => {
    const registry = { get: vi.fn() } as unknown as ProviderRegistry;
    const reconciliationRunService = makeReconciliationRunService();
    const integrationService = { getCredentials: vi.fn(async () => null) } as unknown as IntegrationService;
    const customerService = { findExistingUpdatedAt: vi.fn(), upsertMany: vi.fn() } as unknown as CustomerService;
    const processor = new ReconciliationProcessorService(
      registry,
      reconciliationRunService as unknown as ReconciliationRunService,
      integrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
    );

    await processor.handleReconciliationRequested(makeEvent());

    expect(reconciliationRunService.failReconciliationRun).toHaveBeenCalledWith('run_1', expect.stringContaining('No credentials'));
    expect(registry.get).not.toHaveBeenCalled();
  });

  it('fails the run when a page fetch throws', async () => {
    const fetchCustomers = vi.fn(async () => {
      throw new Error('Shopify customer fetch failed with status 500.');
    });
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const reconciliationRunService = makeReconciliationRunService();
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = { findExistingUpdatedAt: vi.fn(), upsertMany: vi.fn() } as unknown as CustomerService;
    const processor = new ReconciliationProcessorService(
      registry,
      reconciliationRunService as unknown as ReconciliationRunService,
      integrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
    );

    await processor.handleReconciliationRequested(makeEvent());

    expect(reconciliationRunService.failReconciliationRun).toHaveBeenCalledWith('run_1', 'Shopify customer fetch failed with status 500.');
    expect(reconciliationRunService.completeReconciliationRun).not.toHaveBeenCalled();
  });

  it('counts a discrepancy as found but not repaired when the repair upsert throws, and still completes the run', async () => {
    const page: CustomerPage = {
      customers: [{ externalId: '1', email: null, firstName: null, lastName: null, phone: null, sourceUpdatedAt: new Date() }],
      nextCursor: null,
    };
    const fetchCustomers = vi.fn(async () => page);
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const reconciliationRunService = makeReconciliationRunService();
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = {
      findExistingUpdatedAt: vi.fn(async () => new Map()),
      upsertMany: vi.fn(async () => {
        throw new Error('constraint violation');
      }),
    } as unknown as CustomerService;
    const processor = new ReconciliationProcessorService(
      registry,
      reconciliationRunService as unknown as ReconciliationRunService,
      integrationService,
      customerService,
      makeProductService(),
      makeOrderService(),
    );

    await processor.handleReconciliationRequested(makeEvent());

    expect(reconciliationRunService.recordProgress).toHaveBeenCalledWith('run_1', {
      recordsChecked: 1,
      discrepanciesFound: 1,
      discrepanciesRepaired: 0,
    });
    expect(reconciliationRunService.completeReconciliationRun).toHaveBeenCalledWith('run_1');
  });

  it('reconciles customers, then products, then orders in the same run, with cumulative progress', async () => {
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
    const reconciliationRunService = makeReconciliationRunService();
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = {
      findExistingUpdatedAt: vi.fn(async () => new Map()),
      upsertMany: vi.fn(async () => 1),
    } as unknown as CustomerService;
    const productService = makeProductService();
    const orderService = makeOrderService();
    const processor = new ReconciliationProcessorService(
      registry,
      reconciliationRunService as unknown as ReconciliationRunService,
      integrationService,
      customerService,
      productService,
      orderService,
    );

    await processor.handleReconciliationRequested(makeEvent());

    expect(callOrder).toEqual(['customers', 'products', 'orders']);
    // findExistingUpdatedAt returns an empty map for every resource here, so each fetched record counts as missing.
    expect(reconciliationRunService.recordProgress).toHaveBeenNthCalledWith(3, 'run_1', {
      recordsChecked: 3,
      discrepanciesFound: 3,
      discrepanciesRepaired: 3,
    });
    expect(reconciliationRunService.completeReconciliationRun).toHaveBeenCalledWith('run_1');
  });

  it('skips product and order reconciliation entirely when the adapter does not support them', async () => {
    const customerPage: CustomerPage = { customers: [], nextCursor: null };
    const fetchCustomers = vi.fn(async () => customerPage);
    const registry = { get: vi.fn(() => ({ fetchCustomers }) as unknown as ProviderAdapter) } as unknown as ProviderRegistry;
    const reconciliationRunService = makeReconciliationRunService();
    const integrationService = { getCredentials: vi.fn(async () => credentials) } as unknown as IntegrationService;
    const customerService = { findExistingUpdatedAt: vi.fn(async () => new Map()), upsertMany: vi.fn(async () => 0) } as unknown as CustomerService;
    const productService = makeProductService();
    const orderService = makeOrderService();
    const processor = new ReconciliationProcessorService(
      registry,
      reconciliationRunService as unknown as ReconciliationRunService,
      integrationService,
      customerService,
      productService,
      orderService,
    );

    await processor.handleReconciliationRequested(makeEvent());

    expect(productService.upsertMany).not.toHaveBeenCalled();
    expect(orderService.upsertMany).not.toHaveBeenCalled();
    expect(reconciliationRunService.completeReconciliationRun).toHaveBeenCalledWith('run_1');
  });
});
