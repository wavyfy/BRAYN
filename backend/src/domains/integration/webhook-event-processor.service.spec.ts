import { describe, expect, it, vi } from 'vitest';
import { WebhookEventProcessorService } from './webhook-event-processor.service';
import { createEvent } from '../../common/events/domain-event';
import type { DatabaseService } from '../../database/database.service';
import type { CustomerService } from '../commerce/customer.service';
import type { ProductService } from '../commerce/product.service';
import type { OrderService } from '../commerce/order.service';
import type { StructuredLoggerService } from '../../common/logging/structured-logger.service';

function makeChain() {
  const chain: Record<string, unknown> = {
    set: vi.fn(() => chain),
    where: vi.fn(async () => undefined),
  };
  return chain;
}

function makeProcessor() {
  const updateChain = makeChain();
  const client = { update: vi.fn(() => updateChain) };
  const database = { client } as unknown as DatabaseService;
  const customerService = { upsertMany: vi.fn(async () => 1) } as unknown as CustomerService;
  const productService = { upsertMany: vi.fn(async () => ({ productsWritten: 1, variantsWritten: 0 })) } as unknown as ProductService;
  const orderService = {
    upsertMany: vi.fn(async () => ({ ordersWritten: 1, lineItemsWritten: 0 })),
    upsertFulfillments: vi.fn(async () => 1),
  } as unknown as OrderService;
  const logger = { error: vi.fn() } as unknown as StructuredLoggerService;

  return {
    processor: new WebhookEventProcessorService(database, customerService, productService, orderService, logger),
    client,
    updateChain,
    customerService,
    productService,
    orderService,
    logger,
  };
}

function makeReceivedEvent(payload: unknown, overrides: { webhookEventId?: string } = {}) {
  return createEvent({
    type: 'integration.webhook.received',
    workspaceId: 'ws_1',
    entityId: 'int_1',
    payload: { provider: 'shopify' as const, eventType: 'customers/update', payload, webhookEventId: overrides.webhookEventId ?? 'wh_1' },
  });
}

describe('WebhookEventProcessorService', () => {
  it('applies a customer resource event and marks the row processed', async () => {
    const { processor, customerService, productService, orderService, updateChain } = makeProcessor();

    const customer = { externalId: '1', email: 'a@x.com', firstName: 'Ada', lastName: 'L', phone: null, sourceUpdatedAt: new Date() };
    await processor.handleWebhookReceived(makeReceivedEvent({ resource: 'customer', data: customer }));

    expect(customerService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', [customer]);
    expect(productService.upsertMany).not.toHaveBeenCalled();
    expect(orderService.upsertMany).not.toHaveBeenCalled();
    expect(updateChain.set).toHaveBeenCalledWith({ status: 'processed', error: null, retryCount: 0 });
  });

  it('applies a product resource event via ProductService.upsertMany', async () => {
    const { processor, productService } = makeProcessor();

    const product = { externalId: '55', title: 'Tee', sourceUpdatedAt: new Date(), variants: [] };
    await processor.handleWebhookReceived(makeReceivedEvent({ resource: 'product', data: product }));

    expect(productService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', [product]);
  });

  it('applies an order resource event via OrderService.upsertMany', async () => {
    const { processor, orderService } = makeProcessor();

    const order = { externalId: '900', customerExternalId: null, totalPrice: '19.99', sourceUpdatedAt: new Date(), lineItems: [] };
    await processor.handleWebhookReceived(makeReceivedEvent({ resource: 'order', data: order }));

    expect(orderService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', [order]);
  });

  it('applies a fulfillment resource event via OrderService.upsertFulfillments', async () => {
    const { processor, orderService } = makeProcessor();

    const fulfillment = {
      externalId: '7001',
      orderExternalId: '900',
      status: 'success',
      trackingCompany: 'UPS',
      trackingNumber: '1Z999',
      trackingUrl: 'https://ups.com/track/1Z999',
      shipmentStatus: 'in_transit',
      sourceUpdatedAt: new Date(),
    };
    await processor.handleWebhookReceived(makeReceivedEvent({ resource: 'fulfillment', data: fulfillment }));

    expect(orderService.upsertFulfillments).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', [fulfillment]);
  });

  it('does nothing when workspaceId/entityId are missing from the event envelope', async () => {
    const { processor, customerService } = makeProcessor();

    await processor.handleWebhookReceived(
      createEvent({
        type: 'integration.webhook.received',
        payload: { provider: 'shopify' as const, eventType: 'customers/update', payload: { resource: 'customer', data: {} }, webhookEventId: 'wh_1' },
      }),
    );

    expect(customerService.upsertMany).not.toHaveBeenCalled();
  });

  it('does nothing when the payload is not a recognized resource event', async () => {
    const { processor, customerService, client } = makeProcessor();

    await processor.handleWebhookReceived(makeReceivedEvent({ foo: 'bar' }));

    expect(customerService.upsertMany).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it('retries a transient upsert failure and marks the row processed once it succeeds', async () => {
    const { processor, customerService, updateChain } = makeProcessor();
    vi.mocked(customerService.upsertMany).mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce(1);

    const customer = { externalId: '1', email: null, firstName: null, lastName: null, phone: null, sourceUpdatedAt: new Date() };
    await processor.handleWebhookReceived(makeReceivedEvent({ resource: 'customer', data: customer }));

    expect(customerService.upsertMany).toHaveBeenCalledTimes(2);
    expect(updateChain.set).toHaveBeenCalledWith({ status: 'processed', error: null, retryCount: 0 });
  });

  it('moves the row to dead_letter and logs once retries are exhausted, without rethrowing', async () => {
    const { processor, customerService, logger, updateChain } = makeProcessor();
    vi.mocked(customerService.upsertMany).mockRejectedValue(new Error('db down'));

    const customer = { externalId: '1', email: null, firstName: null, lastName: null, phone: null, sourceUpdatedAt: new Date() };
    await expect(
      processor.handleWebhookReceived(makeReceivedEvent({ resource: 'customer', data: customer }, { webhookEventId: 'wh_dead' })),
    ).resolves.toBeUndefined();

    expect(customerService.upsertMany).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(updateChain.set).toHaveBeenCalledWith({ status: 'dead_letter', error: 'db down', retryCount: 3 });
  });
});
