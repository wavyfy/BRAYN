import { describe, expect, it, vi } from 'vitest';
import { WebhookEventProcessorService } from './webhook-event-processor.service';
import { createEvent } from '../../common/events/domain-event';
import type { CustomerService } from '../commerce/customer.service';
import type { ProductService } from '../commerce/product.service';
import type { OrderService } from '../commerce/order.service';
import type { StructuredLoggerService } from '../../common/logging/structured-logger.service';

function makeProcessor() {
  const customerService = { upsertMany: vi.fn(async () => ({ created: 1, updated: 0 })) } as unknown as CustomerService;
  const productService = { upsertMany: vi.fn(async () => ({ created: 1, updated: 0 })) } as unknown as ProductService;
  const orderService = { upsertMany: vi.fn(async () => ({ created: 1, updated: 0 })) } as unknown as OrderService;
  const logger = { error: vi.fn() } as unknown as StructuredLoggerService;

  return {
    processor: new WebhookEventProcessorService(customerService, productService, orderService, logger),
    customerService,
    productService,
    orderService,
    logger,
  };
}

describe('WebhookEventProcessorService', () => {
  it('applies a customer resource event via CustomerService.upsertMany', async () => {
    const { processor, customerService, productService, orderService } = makeProcessor();

    const customer = { externalId: '1', email: 'a@x.com', firstName: 'Ada', lastName: 'L', phone: null, sourceUpdatedAt: new Date() };
    await processor.handleWebhookReceived(
      createEvent({
        type: 'integration.webhook.received',
        workspaceId: 'ws_1',
        entityId: 'int_1',
        payload: { provider: 'shopify', eventType: 'customers/update', payload: { resource: 'customer', data: customer } },
      }),
    );

    expect(customerService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', [customer]);
    expect(productService.upsertMany).not.toHaveBeenCalled();
    expect(orderService.upsertMany).not.toHaveBeenCalled();
  });

  it('applies a product resource event via ProductService.upsertMany', async () => {
    const { processor, productService } = makeProcessor();

    const product = { externalId: '55', title: 'Tee', sourceUpdatedAt: new Date(), variants: [] };
    await processor.handleWebhookReceived(
      createEvent({
        type: 'integration.webhook.received',
        workspaceId: 'ws_1',
        entityId: 'int_1',
        payload: { provider: 'shopify', eventType: 'products/create', payload: { resource: 'product', data: product } },
      }),
    );

    expect(productService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', [product]);
  });

  it('applies an order resource event via OrderService.upsertMany', async () => {
    const { processor, orderService } = makeProcessor();

    const order = { externalId: '900', customerExternalId: null, totalPrice: '19.99', sourceUpdatedAt: new Date(), lineItems: [] };
    await processor.handleWebhookReceived(
      createEvent({
        type: 'integration.webhook.received',
        workspaceId: 'ws_1',
        entityId: 'int_1',
        payload: { provider: 'shopify', eventType: 'orders/updated', payload: { resource: 'order', data: order } },
      }),
    );

    expect(orderService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', [order]);
  });

  it('does nothing when workspaceId/entityId are missing from the event envelope', async () => {
    const { processor, customerService } = makeProcessor();

    await processor.handleWebhookReceived(
      createEvent({
        type: 'integration.webhook.received',
        payload: { provider: 'shopify', eventType: 'customers/update', payload: { resource: 'customer', data: {} } },
      }),
    );

    expect(customerService.upsertMany).not.toHaveBeenCalled();
  });

  it('does nothing when the payload is not a recognized resource event', async () => {
    const { processor, customerService } = makeProcessor();

    await processor.handleWebhookReceived(
      createEvent({
        type: 'integration.webhook.received',
        workspaceId: 'ws_1',
        entityId: 'int_1',
        payload: { provider: 'shopify', eventType: 'app/uninstalled', payload: { foo: 'bar' } },
      }),
    );

    expect(customerService.upsertMany).not.toHaveBeenCalled();
  });

  it('logs and swallows an upsert failure instead of rethrowing — a consumer failure must not un-process a persisted delivery', async () => {
    const { processor, customerService, logger } = makeProcessor();
    vi.mocked(customerService.upsertMany).mockRejectedValueOnce(new Error('db down'));

    const customer = { externalId: '1', email: null, firstName: null, lastName: null, phone: null, sourceUpdatedAt: new Date() };
    await expect(
      processor.handleWebhookReceived(
        createEvent({
          type: 'integration.webhook.received',
          workspaceId: 'ws_1',
          entityId: 'int_1',
          payload: { provider: 'shopify', eventType: 'customers/update', payload: { resource: 'customer', data: customer } },
        }),
      ),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
