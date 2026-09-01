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

function makeLineItemInsertChain() {
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
};

describe('OrderService', () => {
  describe('upsertMany()', () => {
    it('does nothing and returns zero counts for an empty batch', async () => {
      const client = { select: vi.fn(), insert: vi.fn() };
      const service = new OrderService({ client } as unknown as DatabaseService);

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', []);

      expect(result).toEqual({ ordersWritten: 0, lineItemsWritten: 0 });
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

      expect(result).toEqual({ ordersWritten: 1, lineItemsWritten: 1 });
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

      expect(result).toEqual({ ordersWritten: 1, lineItemsWritten: 0 });
      expect(insert).toHaveBeenCalledTimes(1);
    });
  });
});
