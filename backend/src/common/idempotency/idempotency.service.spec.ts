import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { IdempotencyService } from './idempotency.service';
import type { DatabaseService } from '../../database/database.service';

/**
 * Mocks Drizzle's fluent query-builder chain rather than a live database —
 * this proves IdempotencyService calls insert/update correctly and
 * interprets the result correctly, not that Postgres behaves as expected
 * under real concurrency (that's idempotency.service.db.spec.ts).
 */
function makeChain(finalResult: unknown) {
  return {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn(async () => finalResult),
    set: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => finalResult),
    then: (resolve: (value: unknown) => void) => resolve(undefined),
  };
}

const dialect = new PgDialect();
const render = (fragment: SQL) => dialect.sqlToQuery(fragment).sql;

describe('IdempotencyService', () => {
  it('reserve() returns true when the key was newly inserted or reclaimed', async () => {
    const chain = makeChain([{ key: 'abc' }]);
    const client = { insert: vi.fn(() => chain) };
    const service = new IdempotencyService({ client } as unknown as DatabaseService);

    expect(await service.reserve('abc')).toBe(true);
    expect(client.insert).toHaveBeenCalledTimes(1);
  });

  it('reserve() returns false when the key exists and is not reclaimable (nothing returned)', async () => {
    const chain = makeChain([]);
    const client = { insert: vi.fn(() => chain) };
    const service = new IdempotencyService({ client } as unknown as DatabaseService);

    expect(await service.reserve('abc')).toBe(false);
  });

  it('reserve() without a lease only reclaims a failed key', async () => {
    const chain = makeChain([]);
    const service = new IdempotencyService({ client: { insert: vi.fn(() => chain) } } as unknown as DatabaseService);

    await service.reserve('abc');

    const { set, setWhere } = chain.onConflictDoUpdate.mock.calls[0][0];
    expect(set).toEqual(expect.objectContaining({ status: 'pending', completedAt: null }));
    const where = render(setWhere);
    expect(where).toContain('"status" = $1');
    expect(where).not.toContain('reserved_at');
  });

  it('reserve() with a lease also reclaims a pending key whose lease expired', async () => {
    const chain = makeChain([]);
    const service = new IdempotencyService({ client: { insert: vi.fn(() => chain) } } as unknown as DatabaseService);

    await service.reserve('abc', { leaseMs: 60_000 });

    const query = dialect.sqlToQuery(chain.onConflictDoUpdate.mock.calls[0][0].setWhere);
    expect(query.sql).toContain('"reserved_at" < now() -');
    expect(query.params).toEqual(expect.arrayContaining(['failed', 'pending', 60_000]));
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

  it('fail() marks only a still-pending key failed, never a completed one', async () => {
    const chain = makeChain(undefined);
    const service = new IdempotencyService({ client: { update: vi.fn(() => chain) } } as unknown as DatabaseService);

    await service.fail('abc');

    expect(chain.set).toHaveBeenCalledWith({ status: 'failed' });
    const query = dialect.sqlToQuery(chain.where.mock.calls[0][0]);
    expect(query.params).toEqual(['abc', 'pending']);
  });

  it.each([
    [[{ status: 'completed' }], true],
    [[{ status: 'pending' }], false],
    [[], false],
  ])('isCompleted() for rows %j → %s', async (rows, expected) => {
    const chain = makeChain(rows);
    const service = new IdempotencyService({ client: { select: vi.fn(() => chain) } } as unknown as DatabaseService);

    expect(await service.isCompleted('abc')).toBe(expected);
  });
});
