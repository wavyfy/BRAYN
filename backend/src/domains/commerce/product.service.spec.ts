import { describe, expect, it, vi } from 'vitest';
import { ProductService, type NormalizedProduct } from './product.service';
import type { DatabaseService } from '../../database/database.service';

function makeProductInsertChain(returned: { id: string; externalId: string }[]) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    returning: vi.fn(async () => returned),
  };
  return chain;
}

function makeVariantInsertChain() {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(async () => undefined),
  };
  return chain;
}

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

/** Same shape as `CustomerIntelligenceService.listCustomers`'s own test helper — a chainable select mock ending in `offset()`. */
function makePaginatedSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    offset: vi.fn(async () => result),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

function makeSelectQueue(results: unknown[]) {
  let i = 0;
  return vi.fn(() => (i === 0 ? makePaginatedSelectChain(results[i++]) : makeSelectChain(results[i++])));
}

const product: NormalizedProduct = {
  externalId: '55',
  title: 'Classic Tee',
  sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
  variants: [
    { externalId: '901', sku: 'TEE-S', price: '19.99', inventoryQuantity: 10, sourceUpdatedAt: null },
    { externalId: '902', sku: 'TEE-M', price: '19.99', inventoryQuantity: 5, sourceUpdatedAt: null },
  ],
};

describe('ProductService', () => {
  describe('upsertMany()', () => {
    it('does nothing and returns zero counts for an empty batch', async () => {
      const client = { insert: vi.fn() };
      const service = new ProductService({ client } as unknown as DatabaseService);

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', []);

      expect(result).toEqual({ productsWritten: 0, variantsWritten: 0 });
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('upserts products, then links variants to the returned product id', async () => {
      const productChain = makeProductInsertChain([{ id: 'prod_1', externalId: '55' }]);
      const variantChain = makeVariantInsertChain();
      const insert = vi.fn().mockReturnValueOnce(productChain).mockReturnValueOnce(variantChain);
      const client = { insert };
      const service = new ProductService({ client } as unknown as DatabaseService);

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', [product]);

      expect(result).toEqual({ productsWritten: 1, variantsWritten: 2 });
      expect(productChain.values).toHaveBeenCalledWith([
        {
          workspaceId: 'ws_1',
          integrationId: 'int_1',
          provider: 'shopify',
          externalId: '55',
          title: 'Classic Tee',
          sourceUpdatedAt: product.sourceUpdatedAt,
        },
      ]);
      const variantValues = (variantChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<
        Record<string, unknown>
      >;
      expect(variantValues).toHaveLength(2);
      expect(variantValues[0]).toMatchObject({
        workspaceId: 'ws_1',
        integrationId: 'int_1',
        provider: 'shopify',
        productId: 'prod_1',
        externalId: '901',
      });
    });

    it('skips variants for a product whose upsert did not come back with an id', async () => {
      const productChain = makeProductInsertChain([]);
      const insert = vi.fn().mockReturnValueOnce(productChain);
      const client = { insert };
      const service = new ProductService({ client } as unknown as DatabaseService);

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', [product]);

      expect(result).toEqual({ productsWritten: 1, variantsWritten: 0 });
      expect(insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('list()', () => {
    it('returns an empty page without querying variants when there are no products', async () => {
      const select = makeSelectQueue([[]]);
      const service = new ProductService({ client: { select } } as unknown as DatabaseService);

      const result = await service.list('ws_1');

      expect(result).toEqual({ products: [], page: 1, limit: 20, hasMore: false });
      expect(select).toHaveBeenCalledTimes(1);
    });

    it('lists products with their variants, and reports hasMore correctly', async () => {
      const select = makeSelectQueue([
        [{ id: 'prod_1', title: 'Classic Tee' }, { id: 'prod_2', title: 'Denim Jacket' }, { id: 'prod_3', title: 'Wool Scarf' }], // limit+1 = 3, limit=2 -> hasMore
        [
          { id: 'var_1', productId: 'prod_1', sku: 'TEE-S', price: '19.99', inventoryQuantity: 10 },
          { id: 'var_2', productId: 'prod_1', sku: 'TEE-M', price: '19.99', inventoryQuantity: 5 },
          { id: 'var_3', productId: 'prod_2', sku: 'JKT-M', price: '89.99', inventoryQuantity: 2 },
        ],
      ]);
      const service = new ProductService({ client: { select } } as unknown as DatabaseService);

      const result = await service.list('ws_1', { limit: 2 });

      expect(result).toEqual({
        products: [
          {
            id: 'prod_1',
            title: 'Classic Tee',
            variants: [
              { id: 'var_1', sku: 'TEE-S', price: '19.99', inventoryQuantity: 10 },
              { id: 'var_2', sku: 'TEE-M', price: '19.99', inventoryQuantity: 5 },
            ],
          },
          { id: 'prod_2', title: 'Denim Jacket', variants: [{ id: 'var_3', sku: 'JKT-M', price: '89.99', inventoryQuantity: 2 }] },
        ],
        page: 1,
        limit: 2,
        hasMore: true,
      });
    });

    it('returns an empty variants array for a product with no variant rows', async () => {
      const select = makeSelectQueue([[{ id: 'prod_1', title: 'Classic Tee' }], []]);
      const service = new ProductService({ client: { select } } as unknown as DatabaseService);

      const result = await service.list('ws_1');

      expect(result.products).toEqual([{ id: 'prod_1', title: 'Classic Tee', variants: [] }]);
    });

    it('passes a title search filter through to the product query', async () => {
      const select = makeSelectQueue([[{ id: 'prod_1', title: 'Classic Tee' }], []]);
      const service = new ProductService({ client: { select } } as unknown as DatabaseService);

      const result = await service.list('ws_1', { search: 'tee' });

      expect(select).toHaveBeenCalledTimes(2);
      expect(result.products).toEqual([{ id: 'prod_1', title: 'Classic Tee', variants: [] }]);
    });

    it('scopes both the product and variant queries to the given workspaceId', async () => {
      const productChain = makePaginatedSelectChain([{ id: 'prod_1', title: 'Classic Tee' }]);
      const variantChain = makeSelectChain([]);
      const select = vi.fn().mockReturnValueOnce(productChain).mockReturnValueOnce(variantChain);
      const service = new ProductService({ client: { select } } as unknown as DatabaseService);

      await service.list('ws_other');

      expect(productChain.where).toHaveBeenCalledTimes(1);
      expect(variantChain.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('findExistingUpdatedAt()', () => {
    it('returns an empty map without querying for an empty batch', async () => {
      const client = { select: vi.fn() };
      const service = new ProductService({ client } as unknown as DatabaseService);

      const result = await service.findExistingUpdatedAt('ws_1', 'shopify', []);

      expect(result).toEqual(new Map());
      expect(client.select).not.toHaveBeenCalled();
    });

    it('maps each existing externalId to its stored sourceUpdatedAt', async () => {
      const client = { select: vi.fn(() => makeSelectChain([{ externalId: '55', sourceUpdatedAt: product.sourceUpdatedAt }])) };
      const service = new ProductService({ client } as unknown as DatabaseService);

      const result = await service.findExistingUpdatedAt('ws_1', 'shopify', ['55', 'missing']);

      expect(result).toEqual(new Map([['55', product.sourceUpdatedAt]]));
    });
  });
});
