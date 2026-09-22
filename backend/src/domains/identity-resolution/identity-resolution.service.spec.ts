import { describe, expect, it, vi } from 'vitest';
import { IdentityResolutionService } from './identity-resolution.service';
import type { DatabaseService } from '../../database/database.service';

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => result),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

function makeInsertChain(returned: { id: string }) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    returning: vi.fn(async () => [returned]),
  };
  return chain;
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {
    set: vi.fn(() => chain),
    where: vi.fn(async () => undefined),
  };
  return chain;
}

function makeDuplicateInsertChain() {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(async () => undefined),
  };
  return chain;
}

describe('IdentityResolutionService', () => {
  describe('resolveMany()', () => {
    it('does nothing for an empty batch', async () => {
      const client = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', []);

      expect(client.select).not.toHaveBeenCalled();
    });

    it('does nothing when every matched row is already resolved', async () => {
      const select = vi.fn(() => makeSelectChain([]));
      const client = { select, insert: vi.fn(), update: vi.fn() };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1']);

      expect(select).toHaveBeenCalledTimes(1);
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('creates a new canonical customer for an unresolved row with an email, and links it', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'cc_1', email: 'A@Example.com' }]));
      const insertChain = makeInsertChain({ id: 'canon_1' });
      const updateChain = makeUpdateChain();
      const client = { select, insert: vi.fn(() => insertChain), update: vi.fn(() => updateChain) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1']);

      expect(insertChain.values).toHaveBeenCalledWith({ workspaceId: 'ws_1', primaryEmail: 'a@example.com' });
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ canonicalCustomerId: 'canon_1' }));
    });

    it('resolves a null-email row to its own canonical customer', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'cc_2', email: null }]));
      const insertChain = makeInsertChain({ id: 'canon_2' });
      const updateChain = makeUpdateChain();
      const client = { select, insert: vi.fn(() => insertChain), update: vi.fn(() => updateChain) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['2']);

      expect(insertChain.values).toHaveBeenCalledWith({ workspaceId: 'ws_1', primaryEmail: null });
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ canonicalCustomerId: 'canon_2' }));
    });

    it('links two unresolved rows with the same email (case-insensitive) to the same canonical customer', async () => {
      const select = vi.fn(() =>
        makeSelectChain([
          { id: 'cc_1', email: 'a@example.com' },
          { id: 'cc_2', email: 'A@EXAMPLE.COM' },
        ]),
      );
      // The second insert hits the unique-index conflict and onConflictDoUpdate returns the same existing row.
      const insertChain = makeInsertChain({ id: 'canon_1' });
      const updateChain = makeUpdateChain();
      const client = { select, insert: vi.fn(() => insertChain), update: vi.fn(() => updateChain) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1', '2']);

      const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
      expect(setCalls[0][0]).toMatchObject({ canonicalCustomerId: 'canon_1' });
      expect(setCalls[1][0]).toMatchObject({ canonicalCustomerId: 'canon_1' });
    });

    it('flags a pending duplicate when the resolved row shares a phone with a different, already-linked canonical customer', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'cc_2', email: 'b@example.com', phone: '555-1234' }]));
      const selectDistinct = vi.fn(() => makeSelectChain([{ canonicalCustomerId: 'canon_1' }]));
      const insertChain = makeInsertChain({ id: 'canon_2' });
      const duplicateInsertChain = makeDuplicateInsertChain();
      const updateChain = makeUpdateChain();
      const insert = vi.fn().mockReturnValueOnce(insertChain).mockReturnValueOnce(duplicateInsertChain);
      const client = { select, selectDistinct, insert, update: vi.fn(() => updateChain) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['2']);

      expect(selectDistinct).toHaveBeenCalledTimes(1);
      expect(duplicateInsertChain.values).toHaveBeenCalledWith([
        { workspaceId: 'ws_1', canonicalCustomerAId: 'canon_1', canonicalCustomerBId: 'canon_2', matchedSignal: 'phone', matchedValue: '555-1234' },
      ]);
    });

    it('does not check for phone duplicates when the row has no phone', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'cc_1', email: 'a@example.com', phone: null }]));
      const selectDistinct = vi.fn();
      const insertChain = makeInsertChain({ id: 'canon_1' });
      const client = { select, selectDistinct, insert: vi.fn(() => insertChain), update: vi.fn(() => makeUpdateChain()) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1']);

      expect(selectDistinct).not.toHaveBeenCalled();
    });

    it('does not flag a duplicate when no other canonical customer shares the phone', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'cc_1', email: 'a@example.com', phone: '555-1234' }]));
      const selectDistinct = vi.fn(() => makeSelectChain([]));
      const insertChain = makeInsertChain({ id: 'canon_1' });
      const insert = vi.fn().mockReturnValueOnce(insertChain);
      const client = { select, selectDistinct, insert, update: vi.fn(() => makeUpdateChain()) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1']);

      expect(insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveWebsiteVisitor() — anonymous → known linking (Part 3)', () => {
    it('links an unlinked visitor to a newly created canonical customer for a reliable email signal', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'visitor_1', canonicalCustomerId: null }]));
      const insertChain = makeInsertChain({ id: 'canon_new' });
      const updateChain = makeUpdateChain();
      const client = { select, insert: vi.fn(() => insertChain), update: vi.fn(() => updateChain) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveWebsiteVisitor('ws_1', 'visitor_1', 'Shopper@Example.com');

      expect(insertChain.values).toHaveBeenCalledWith({ workspaceId: 'ws_1', primaryEmail: 'shopper@example.com' });
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ canonicalCustomerId: 'canon_new' }));
    });

    it('links to the SAME canonical customer an email already resolved from commerce (unifies anonymous + known identity)', async () => {
      // onConflictDoUpdate hitting the existing (workspace, email) row returns the pre-existing canonical customer.
      const select = vi.fn(() => makeSelectChain([{ id: 'visitor_1', canonicalCustomerId: null }]));
      const insertChain = makeInsertChain({ id: 'canon_existing_from_shopify' });
      const updateChain = makeUpdateChain();
      const client = { select, insert: vi.fn(() => insertChain), update: vi.fn(() => updateChain) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveWebsiteVisitor('ws_1', 'visitor_1', 'known@example.com');

      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ canonicalCustomerId: 'canon_existing_from_shopify' }));
    });

    it('does nothing when the visitor does not exist in this workspace (tenant isolation)', async () => {
      const select = vi.fn(() => makeSelectChain([]));
      const insert = vi.fn();
      const update = vi.fn();
      const client = { select, insert, update };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveWebsiteVisitor('ws_1', 'visitor_from_another_workspace', 'shopper@example.com');

      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('does nothing when the visitor is already linked — no re-link, even to a different email (idempotent, no conflicting overwrite)', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'visitor_1', canonicalCustomerId: 'canon_already_linked' }]));
      const insert = vi.fn();
      const update = vi.fn();
      const client = { select, insert, update };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveWebsiteVisitor('ws_1', 'visitor_1', 'a-different-email@example.com');

      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('is idempotent across repeated calls with the same signal: the second call is a no-op once linked', async () => {
      const insertChain = makeInsertChain({ id: 'canon_1' });
      const updateChain = makeUpdateChain();
      const insert = vi.fn(() => insertChain);
      const update = vi.fn(() => updateChain);

      const select = vi
        .fn()
        .mockReturnValueOnce(makeSelectChain([{ id: 'visitor_1', canonicalCustomerId: null }]))
        .mockReturnValueOnce(makeSelectChain([{ id: 'visitor_1', canonicalCustomerId: 'canon_1' }]));
      const client = { select, insert, update };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveWebsiteVisitor('ws_1', 'visitor_1', 'shopper@example.com');
      await service.resolveWebsiteVisitor('ws_1', 'visitor_1', 'shopper@example.com');

      expect(insert).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenCalledTimes(1);
    });
  });

  describe('listDuplicates()', () => {
    it('returns pending duplicate candidates for the workspace', async () => {
      const rows = [{ id: 'dup_1', canonicalCustomerAId: 'canon_1', canonicalCustomerBId: 'canon_2', status: 'pending' }];
      const select = vi.fn(() => makeSelectChain(rows));
      const client = { select };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      const result = await service.listDuplicates('ws_1');

      expect(result).toEqual(rows);
    });
  });
});
