import { describe, expect, it, vi } from 'vitest';
import { IdentityResolutionService } from './identity-resolution.service';
import type { DatabaseService } from '../../database/database.service';

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
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
  });
});
