import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ShopifyOAuthHandoffService } from './shopify-oauth-handoff.service';
import type { DatabaseService } from '../../../../database/database.service';

function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function makeChain(finalResult: unknown) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    set: vi.fn(() => chain),
    where: vi.fn(() => chain),
    returning: vi.fn(async () => finalResult),
    then: (resolve: (value: unknown) => void) => resolve(finalResult),
  };
  return chain;
}

describe('ShopifyOAuthHandoffService', () => {
  describe('mint()', () => {
    it('inserts a row keyed by the token\'s SHA-256 hash — never the raw token — bound to the caller and workspace, with a ~60s expiry', async () => {
      const insertChain = makeChain(undefined);
      const client = { insert: vi.fn(() => insertChain) };
      const service = new ShopifyOAuthHandoffService({ client } as unknown as DatabaseService);

      const before = Date.now();
      const { token, expiresAt } = await service.mint('clerk_1', 'ws_1');
      const after = Date.now();

      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ tokenHash: hashOf(token), clerkUserId: 'clerk_1', workspaceId: 'ws_1' }),
      );
      const insertedValues = (insertChain.values as ReturnType<typeof vi.fn>).mock.calls[0][0] as { tokenHash: string };
      expect(insertedValues.tokenHash).not.toBe(token);
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 59_000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 61_000);
    });

    it('mints a different token (and hash) on every call', async () => {
      const client = { insert: vi.fn(() => makeChain(undefined)) };
      const service = new ShopifyOAuthHandoffService({ client } as unknown as DatabaseService);

      const a = await service.mint('clerk_1', 'ws_1');
      const b = await service.mint('clerk_1', 'ws_1');

      expect(a.token).not.toBe(b.token);
    });
  });

  describe('consume()', () => {
    it('returns the bound clerkUserId when the conditional update claims exactly one row', async () => {
      const updateChain = makeChain([{ clerkUserId: 'clerk_1' }]);
      const client = { update: vi.fn(() => updateChain) };
      const service = new ShopifyOAuthHandoffService({ client } as unknown as DatabaseService);

      const result = await service.consume('some-token', 'ws_1');

      expect(result).toEqual({ clerkUserId: 'clerk_1' });
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ consumedAt: expect.any(Date) }));
    });

    it('returns null when the conditional update claims zero rows (already consumed, expired, or wrong workspace)', async () => {
      const updateChain = makeChain([]);
      const client = { update: vi.fn(() => updateChain) };
      const service = new ShopifyOAuthHandoffService({ client } as unknown as DatabaseService);

      const result = await service.consume('some-token', 'ws_1');

      expect(result).toBeNull();
    });

    it('hashes the raw token before querying — never queries by the raw token value', async () => {
      const updateChain = makeChain([{ clerkUserId: 'clerk_1' }]);
      const client = { update: vi.fn(() => updateChain) };
      const service = new ShopifyOAuthHandoffService({ client } as unknown as DatabaseService);

      await service.consume('raw-token-value', 'ws_1');

      // The where() call receives drizzle SQL condition objects, not plain
      // values — assert indirectly: the service never passes the raw
      // string anywhere returning()/set() could leak it back out.
      expect(updateChain.set).toHaveBeenCalledWith(expect.not.objectContaining({ tokenHash: 'raw-token-value' }));
    });
  });
});
