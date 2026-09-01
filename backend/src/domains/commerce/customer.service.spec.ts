import { describe, expect, it, vi } from 'vitest';
import { CustomerService, type NormalizedCustomer } from './customer.service';
import type { DatabaseService } from '../../database/database.service';

function makeInsertChain() {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(async () => undefined),
  };
  return chain;
}

const customer: NormalizedCustomer = {
  externalId: '123',
  email: 'a@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: null,
  sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('CustomerService', () => {
  describe('upsertMany()', () => {
    it('does nothing and returns 0 for an empty batch', async () => {
      const client = { insert: vi.fn() };
      const service = new CustomerService({ client } as unknown as DatabaseService);

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', []);

      expect(result).toBe(0);
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('inserts rows tagged with workspace/integration/provider and upserts on the dedupe key', async () => {
      const insertChain = makeInsertChain();
      const client = { insert: vi.fn(() => insertChain) };
      const service = new CustomerService({ client } as unknown as DatabaseService);

      const result = await service.upsertMany('ws_1', 'int_1', 'shopify', [customer]);

      expect(result).toBe(1);
      expect(insertChain.values).toHaveBeenCalledWith([
        { workspaceId: 'ws_1', integrationId: 'int_1', provider: 'shopify', ...customer },
      ]);
      const conflictArg = (insertChain.onConflictDoUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        target: unknown[];
        set: Record<string, unknown>;
      };
      expect(conflictArg.target).toHaveLength(3);
      expect(Object.keys(conflictArg.set)).toEqual(
        expect.arrayContaining(['email', 'firstName', 'lastName', 'phone', 'sourceUpdatedAt', 'updatedAt']),
      );
    });
  });
});
