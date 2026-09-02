import { describe, expect, it, vi } from 'vitest';
import { OrderService, type NormalizedOrder } from './order.service';
import type { DatabaseService } from '../../database/database.service';

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

function makeSelectQueue(results: unknown[]) {
  let i = 0;
  return vi.fn(() => makeSelectChain(results[i++]));
}

function makeOrderInsertChain(returned: { id: string; externalId: string }[]) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    returning: vi.fn(async () => returned),
  };
  return chain;
}

function makeLineItemInsertChain(returned: { id: string; externalId: string }[] = []) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    returning: vi.fn(async () => returned),
  };
  return chain;
}

function makeFulfillmentInsertChain() {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(async () => undefined),
  };
  return chain;
}

const order: NormalizedOrder = {
  externalId: '900',
  customerExternalId: '1',
  totalPrice: '19.99',
  sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
  lineItems: [{ externalId: '9001', variantExternalId: '901', quantity: 2, price: '9.99' }],
  refunds: [],
  fulfillments: [],
};

describe('OrderService', () => {
  describe('upsertMany()', () => {
    it('does nothing and returns zero counts for an empty batch', async () => {
      const client = { select: vi.fn(), insert: vi.fn() };
      const service = new OrderService({ client } as unknown as DatabaseService);

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', []);

      expect(result).toEqual({ ordersWritten: 0, lineItemsWritten: 0, refundsWritten: 0, fulfillmentsWritten: 0 });
      expect(client.select).not.toHaveBeenCalled();
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('links the order to an existing customer and the line item to an existing variant', async () => {
      const orderChain = makeOrderInsertChain([{ id: 'order_1', externalId: '900' }]);
      const lineItemChain = makeLineItemInsertChain();
      const insert = vi.fn().mockReturnValueOnce(orderChain).mockReturnValueOnce(lineItemChain);
      const select = makeSelectQueue([
        [{ id: 'cust_1', externalId: '1' }], // customer lookup
        [{ id: 'variant_1', externalId: '901' }], // variant lookup
      ]);
      const client = { select, insert };
      const service = new OrderService({ client } as unknown as DatabaseService);

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', [order]);

      expect(result).toEqual({ ordersWritten: 1, lineItemsWritten: 1, refundsWritten: 0, fulfillmentsWritten: 0 });
      expect(orderChain.values).toHaveBeenCalledWith([
        {
          workspaceId: 'ws_1',
          integrationId: 'int_1',
          provider: 'shopify',
          externalId: '900',
          customerId: 'cust_1',
          totalPrice: '19.99',
          sourceUpdatedAt: order.sourceUpdatedAt,
        },
      ]);
      expect(lineItemChain.values).toHaveBeenCalledWith([
        {
          workspaceId: 'ws_1',
          integrationId: 'int_1',
          provider: 'shopify',
          orderId: 'order_1',
          variantId: 'variant_1',
          externalId: '9001',
          quantity: 2,
          price: '9.99',
        },
      ]);
    });

    it('stores null links, without failing, for a guest order and an unrecognized variant', async () => {
      const guestOrder: NormalizedOrder = {
        ...order,
        customerExternalId: null,
        lineItems: [{ externalId: '9002', variantExternalId: 'not-imported-yet', quantity: 1, price: null }],
      };
      const orderChain = makeOrderInsertChain([{ id: 'order_2', externalId: '900' }]);
      const lineItemChain = makeLineItemInsertChain();
      const insert = vi.fn().mockReturnValueOnce(orderChain).mockReturnValueOnce(lineItemChain);
      // Only the variant lookup runs — no customerExternalId to look up.
      const select = makeSelectQueue([[]]);
      const client = { select, insert };
      const service = new OrderService({ client } as unknown as DatabaseService);

      await service.upsertMany('ws_1', 'int_1', 'shopify', [guestOrder]);

      expect(select).toHaveBeenCalledTimes(1);
      const orderValues = (orderChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<
        Record<string, unknown>
      >;
      expect(orderValues[0].customerId).toBeNull();
      const lineItemValues = (lineItemChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<
        Record<string, unknown>
      >;
      expect(lineItemValues[0].variantId).toBeNull();
    });

    it('skips line items for an order whose insert did not come back with an id', async () => {
      const orderChain = makeOrderInsertChain([]);
      const insert = vi.fn().mockReturnValueOnce(orderChain);
      const select = makeSelectQueue([[{ id: 'cust_1', externalId: '1' }], []]);
      const client = { select, insert };
      const service = new OrderService({ client } as unknown as DatabaseService);

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', [order]);

      expect(result).toEqual({ ordersWritten: 1, lineItemsWritten: 0, refundsWritten: 0, fulfillmentsWritten: 0 });
      expect(insert).toHaveBeenCalledTimes(1);
    });

    it('writes a refund and links its line item to the order line item it refunds', async () => {
      const refundedOrder: NormalizedOrder = {
        ...order,
        refunds: [
          {
            externalId: '9500',
            note: 'Damaged item',
            totalRefunded: '9.99',
            processedAt: new Date('2026-01-02T00:00:00Z'),
            lineItems: [{ externalId: '9501', orderLineItemExternalId: '9001', quantity: 1 }],
          },
        ],
      };
      const orderChain = makeOrderInsertChain([{ id: 'order_1', externalId: '900' }]);
      const lineItemChain = makeLineItemInsertChain([{ id: 'line_item_1', externalId: '9001' }]);
      const refundChain = makeOrderInsertChain([{ id: 'refund_1', externalId: '9500' }]);
      const refundLineItemChain = makeLineItemInsertChain();
      const insert = vi
        .fn()
        .mockReturnValueOnce(orderChain)
        .mockReturnValueOnce(lineItemChain)
        .mockReturnValueOnce(refundChain)
        .mockReturnValueOnce(refundLineItemChain);
      const select = makeSelectQueue([
        [{ id: 'cust_1', externalId: '1' }],
        [{ id: 'variant_1', externalId: '901' }],
      ]);
      const client = { select, insert };
      const service = new OrderService({ client } as unknown as DatabaseService);

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', [refundedOrder]);

      expect(result).toEqual({ ordersWritten: 1, lineItemsWritten: 1, refundsWritten: 1, fulfillmentsWritten: 0 });
      expect(refundChain.values).toHaveBeenCalledWith([
        {
          workspaceId: 'ws_1',
          integrationId: 'int_1',
          provider: 'shopify',
          orderId: 'order_1',
          externalId: '9500',
          note: 'Damaged item',
          totalRefunded: '9.99',
          processedAt: refundedOrder.refunds[0].processedAt,
        },
      ]);
      expect(refundLineItemChain.values).toHaveBeenCalledWith([
        {
          workspaceId: 'ws_1',
          integrationId: 'int_1',
          provider: 'shopify',
          refundId: 'refund_1',
          orderLineItemId: 'line_item_1',
          externalId: '9501',
          quantity: 1,
        },
      ]);
    });

    it("writes an order's embedded fulfillments, linked to the just-upserted order", async () => {
      const fulfilledOrder: NormalizedOrder = {
        ...order,
        fulfillments: [
          {
            externalId: '7001',
            status: 'success',
            trackingCompany: 'UPS',
            trackingNumber: '1Z999',
            trackingUrl: 'https://ups.com/track/1Z999',
            shipmentStatus: 'in_transit',
            sourceUpdatedAt: new Date('2026-01-03T00:00:00Z'),
          },
        ],
      };
      const orderChain = makeOrderInsertChain([{ id: 'order_1', externalId: '900' }]);
      const lineItemChain = makeLineItemInsertChain([{ id: 'line_item_1', externalId: '9001' }]);
      const fulfillmentChain = makeFulfillmentInsertChain();
      const insert = vi.fn().mockReturnValueOnce(orderChain).mockReturnValueOnce(lineItemChain).mockReturnValueOnce(fulfillmentChain);
      const select = makeSelectQueue([
        [{ id: 'cust_1', externalId: '1' }],
        [{ id: 'variant_1', externalId: '901' }],
      ]);
      const client = { select, insert };
      const service = new OrderService({ client } as unknown as DatabaseService);

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', [fulfilledOrder]);

      expect(result).toEqual({ ordersWritten: 1, lineItemsWritten: 1, refundsWritten: 0, fulfillmentsWritten: 1 });
      expect(fulfillmentChain.values).toHaveBeenCalledWith([
        {
          workspaceId: 'ws_1',
          integrationId: 'int_1',
          provider: 'shopify',
          orderId: 'order_1',
          externalId: '7001',
          status: 'success',
          trackingCompany: 'UPS',
          trackingNumber: '1Z999',
          trackingUrl: 'https://ups.com/track/1Z999',
          shipmentStatus: 'in_transit',
          sourceUpdatedAt: fulfilledOrder.fulfillments[0].sourceUpdatedAt,
        },
      ]);
    });
  });

  describe('upsertFulfillments()', () => {
    it('does nothing for an empty batch', async () => {
      const client = { select: vi.fn(), insert: vi.fn() };
      const service = new OrderService({ client } as unknown as DatabaseService);

      const result = await service.upsertFulfillments('ws_1', 'int_1', 'shopify', []);

      expect(result).toBe(0);
      expect(client.select).not.toHaveBeenCalled();
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('resolves the order by external id itself, then writes the fulfillment', async () => {
      const fulfillmentChain = makeFulfillmentInsertChain();
      const insert = vi.fn().mockReturnValueOnce(fulfillmentChain);
      const select = makeSelectQueue([[{ id: 'order_1', externalId: '900' }]]);
      const client = { select, insert };
      const service = new OrderService({ client } as unknown as DatabaseService);

      const result = await service.upsertFulfillments('ws_1', 'int_1', 'shopify', [
        {
          externalId: '7001',
          orderExternalId: '900',
          status: 'success',
          trackingCompany: 'UPS',
          trackingNumber: '1Z999',
          trackingUrl: 'https://ups.com/track/1Z999',
          shipmentStatus: 'in_transit',
          sourceUpdatedAt: new Date('2026-01-03T00:00:00Z'),
        },
      ]);

      expect(result).toBe(1);
      expect(fulfillmentChain.values).toHaveBeenCalledWith([
        expect.objectContaining({ orderId: 'order_1', externalId: '7001' }),
      ]);
    });

    it('skips a fulfillment whose order is not found (not yet imported)', async () => {
      const insert = vi.fn();
      const select = makeSelectQueue([[]]);
      const client = { select, insert };
      const service = new OrderService({ client } as unknown as DatabaseService);

      const result = await service.upsertFulfillments('ws_1', 'int_1', 'shopify', [
        {
          externalId: '7001',
          orderExternalId: 'not-imported-yet',
          status: 'success',
          trackingCompany: null,
          trackingNumber: null,
          trackingUrl: null,
          shipmentStatus: null,
          sourceUpdatedAt: null,
        },
      ]);

      expect(result).toBe(0);
      expect(insert).not.toHaveBeenCalled();
    });
  });

  describe('findExistingUpdatedAt()', () => {
    it('returns an empty map without querying for an empty batch', async () => {
      const client = { select: vi.fn() };
      const service = new OrderService({ client } as unknown as DatabaseService);

      const result = await service.findExistingUpdatedAt('ws_1', 'shopify', []);

      expect(result).toEqual(new Map());
      expect(client.select).not.toHaveBeenCalled();
    });

    it('maps each existing externalId to its stored sourceUpdatedAt', async () => {
      const updatedAt = new Date('2026-01-01T00:00:00Z');
      const select = makeSelectQueue([[{ externalId: '900', sourceUpdatedAt: updatedAt }]]);
      const client = { select };
      const service = new OrderService({ client } as unknown as DatabaseService);

      const result = await service.findExistingUpdatedAt('ws_1', 'shopify', ['900', '901']);

      expect(result).toEqual(new Map([['900', updatedAt]]));
    });
  });
});
