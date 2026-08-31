import { describe, expect, it, vi } from 'vitest';
import { IdempotencyService } from './idempotency.service';
import type { DatabaseService } from '../../database/database.service';

/**
 * Mocks Drizzle's fluent query-builder chain rather than a live database —
 * this proves IdempotencyService calls insert/update correctly and
 * interprets the result correctly, not that Drizzle generates correct
 * SQL (that's Drizzle's own tested responsibility) or that Postgres
 * behaves as expected under real concurrency (verified live, same
 * limitation class as Step 4's mocked Clerk verification).
 */
function makeChain(finalResult: unknown) {
  return {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn(async () => finalResult),
    set: vi.fn().mockReturnThis(),
    where: vi.fn(async () => undefined),
  };
}

describe('IdempotencyService', () => {
  it('reserve() returns true when the key was newly inserted', async () => {
    const chain = makeChain([{ key: 'abc' }]);
    const client = { insert: vi.fn(() => chain) };
    const service = new IdempotencyService({ client } as unknown as DatabaseService);

    const reserved = await service.reserve('abc');

    expect(reserved).toBe(true);
    expect(client.insert).toHaveBeenCalledTimes(1);
    expect(chain.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it('reserve() returns false when the key already exists (conflict → nothing returned)', async () => {
    const chain = makeChain([]);
    const client = { insert: vi.fn(() => chain) };
    const service = new IdempotencyService({ client } as unknown as DatabaseService);

    const reserved = await service.reserve('abc');

    expect(reserved).toBe(false);
  });

  it('complete() updates status and completedAt for the given key', async () => {
    const chain = makeChain(undefined);
    const client = { update: vi.fn(() => chain) };
    const service = new IdempotencyService({ client } as unknown as DatabaseService);

    await service.complete('abc');

    expect(client.update).toHaveBeenCalledTimes(1);
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(chain.where).toHaveBeenCalledTimes(1);
  });
});
