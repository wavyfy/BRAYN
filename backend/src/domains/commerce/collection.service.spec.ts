import { describe, expect, it, vi } from 'vitest';
import { CollectionService } from './collection.service';
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

function makeInsertChain() {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(async () => undefined),
  };
  return chain;
}

describe('CollectionService', () => {
  describe('upsertMany()', () => {
    it('does nothing and returns 0 for an empty batch', async () => {
      const client = { select: vi.fn(), insert: vi.fn() };
      const service = new CollectionService({ client } as unknown as DatabaseService);

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', []);

      expect(result).toBe(0);
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('writes each collection', async () => {
      const insertChain = makeInsertChain();
      const client = { insert: vi.fn(() => insertChain) };
      const service = new CollectionService({ client } as unknown as DatabaseService);
      const collections = [
        { externalId: '10', title: 'Summer Sale', sourceUpdatedAt: new Date('2026-01-01T00:00:00Z') },
      ];

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', collections);

      expect(result).toBe(1);
      expect(insertChain.values).toHaveBeenCalledWith([
        {
          workspaceId: 'ws_1',
          integrationId: 'int_1',
          provider: 'shopify',
          externalId: '10',
          title: 'Summer Sale',
          sourceUpdatedAt: collections[0].sourceUpdatedAt,
        },
      ]);
    });
  });

  describe('upsertCollects()', () => {
    it('does nothing and returns 0 for an empty batch', async () => {
      const client = { select: vi.fn(), insert: vi.fn() };
      const service = new CollectionService({ client } as unknown as DatabaseService);

      const result = await service.upsertCollects('ws_1', 'int_1', 'shopify', []);

      expect(result).toBe(0);
      expect(client.select).not.toHaveBeenCalled();
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('writes a collect once both the collection and product are resolved', async () => {
      const insertChain = makeInsertChain();
      const client = {
        select: makeSelectQueue([
          [{ id: 'coll_1', externalId: '10' }], // collection lookup
          [{ id: 'prod_1', externalId: '55' }], // product lookup
        ]),
        insert: vi.fn(() => insertChain),
      };
      const service = new CollectionService({ client } as unknown as DatabaseService);

      const result = await service.upsertCollects('ws_1', 'int_1', 'shopify', [
        { externalId: '500', collectionExternalId: '10', productExternalId: '55' },
      ]);

      expect(result).toBe(1);
      expect(insertChain.values).toHaveBeenCalledWith([
        {
          workspaceId: 'ws_1',
          integrationId: 'int_1',
          provider: 'shopify',
          collectionId: 'coll_1',
          productId: 'prod_1',
          externalId: '500',
        },
      ]);
    });

    it('skips a collect when the collection is not yet imported', async () => {
      const client = {
        select: makeSelectQueue([
          [], // collection lookup — nothing found
          [{ id: 'prod_1', externalId: '55' }],
        ]),
        insert: vi.fn(),
      };
      const service = new CollectionService({ client } as unknown as DatabaseService);

      const result = await service.upsertCollects('ws_1', 'int_1', 'shopify', [
        { externalId: '500', collectionExternalId: 'not-imported-yet', productExternalId: '55' },
      ]);

      expect(result).toBe(0);
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('skips a collect when the product is not yet imported', async () => {
      const client = {
        select: makeSelectQueue([
          [{ id: 'coll_1', externalId: '10' }],
          [], // product lookup — nothing found
        ]),
        insert: vi.fn(),
      };
      const service = new CollectionService({ client } as unknown as DatabaseService);

      const result = await service.upsertCollects('ws_1', 'int_1', 'shopify', [
        { externalId: '500', collectionExternalId: '10', productExternalId: 'not-imported-yet' },
      ]);

      expect(result).toBe(0);
      expect(client.insert).not.toHaveBeenCalled();
    });
  });

  describe('findExistingUpdatedAt()', () => {
    it('returns an empty map without querying for an empty batch', async () => {
      const client = { select: vi.fn() };
      const service = new CollectionService({ client } as unknown as DatabaseService);

      const result = await service.findExistingUpdatedAt('ws_1', 'shopify', []);

      expect(result).toEqual(new Map());
      expect(client.select).not.toHaveBeenCalled();
    });

    it('maps each existing externalId to its stored sourceUpdatedAt', async () => {
      const updatedAt = new Date('2026-01-01T00:00:00Z');
      const select = makeSelectQueue([[{ externalId: '10', sourceUpdatedAt: updatedAt }]]);
      const client = { select };
      const service = new CollectionService({ client } as unknown as DatabaseService);

      const result = await service.findExistingUpdatedAt('ws_1', 'shopify', ['10', '11']);

      expect(result).toEqual(new Map([['10', updatedAt]]));
    });
  });
});
