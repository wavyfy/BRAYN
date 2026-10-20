import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { eq, like } from 'drizzle-orm';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { idempotencyKeys } from '../../database/schema/idempotency-keys';
import { loadConfiguration } from '../../config/configuration';
import { IdempotencyService } from './idempotency.service';

/**
 * Real-DB lifecycle checks (same approach as full-loop.spec.ts — the dev
 * DATABASE_URL is the only supported database). The mocked unit spec can
 * only prove which query is issued; whether concurrent reservations really
 * deduplicate is Postgres' ON CONFLICT row-locking behavior, so it's
 * proven here against the real engine. Every key carries this run's
 * prefix and is deleted afterwards.
 */
describe('IdempotencyService lifecycle (real DB)', () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let service: IdempotencyService;
  const prefix = `idempotency-db-spec:${randomUUID()}:`;
  const newKey = () => `${prefix}${randomUUID()}`;

  /** What a caller does around its processing: reserve, run, then complete or release. */
  async function run(key: string, work: () => Promise<void>, leaseMs?: number): Promise<'executed' | 'duplicate' | 'failed'> {
    if (!(await service.reserve(key, { leaseMs }))) return 'duplicate';
    try {
      await work();
    } catch {
      await service.fail(key);
      return 'failed';
    }
    await service.complete(key);
    return 'executed';
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [loadConfiguration] }), DatabaseModule],
      providers: [IdempotencyService],
    }).compile();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    service = moduleRef.get(IdempotencyService);
  });

  afterAll(async () => {
    if (db?.isConfigured()) {
      await db.client.delete(idempotencyKeys).where(like(idempotencyKeys.key, `${prefix}%`));
    }
    await moduleRef?.close();
  });

  it('deduplicates a retry after a successful operation', async () => {
    const key = newKey();
    expect(await run(key, async () => undefined)).toBe('executed');
    expect(await run(key, async () => undefined)).toBe('duplicate');
    expect(await service.isCompleted(key)).toBe(true);
  });

  it('allows a retry after the operation throws, and that retry can succeed', async () => {
    const key = newKey();
    let attempts = 0;
    const flaky = async () => {
      attempts++;
      if (attempts === 1) throw new Error('transient');
    };

    expect(await run(key, flaky)).toBe('failed');
    expect(await service.isCompleted(key)).toBe(false);
    expect(await run(key, flaky)).toBe('executed');
    expect(await run(key, flaky)).toBe('duplicate');
    expect(attempts).toBe(2);
  });

  it('lets exactly one of many concurrent reservations of a new key win', async () => {
    const key = newKey();
    const results = await Promise.all(Array.from({ length: 20 }, () => service.reserve(key, { leaseMs: 60_000 })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('lets exactly one of many concurrent retries reclaim a failed key', async () => {
    const key = newKey();
    await service.reserve(key);
    await service.fail(key);

    const results = await Promise.all(Array.from({ length: 20 }, () => service.reserve(key, { leaseMs: 60_000 })));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('rejects a duplicate while the first attempt still holds the key (and reports it as not completed)', async () => {
    const key = newKey();
    expect(await service.reserve(key, { leaseMs: 60_000 })).toBe(true);
    expect(await service.reserve(key, { leaseMs: 60_000 })).toBe(false);
    expect(await service.isCompleted(key)).toBe(false);
  });

  it('never reclaims or downgrades a completed key', async () => {
    const key = newKey();
    await service.reserve(key);
    await service.complete(key);

    await service.fail(key);
    await db.client.update(idempotencyKeys).set({ reservedAt: new Date(Date.now() - 3_600_000) }).where(eq(idempotencyKeys.key, key));

    expect(await service.reserve(key, { leaseMs: 1 })).toBe(false);
    expect(await service.isCompleted(key)).toBe(true);
  });

  it('reclaims a pending key whose lease expired (crashed holder), but only for a caller that opts into a lease', async () => {
    const key = newKey();
    await service.reserve(key, { leaseMs: 60_000 });
    await db.client.update(idempotencyKeys).set({ reservedAt: new Date(Date.now() - 120_000) }).where(eq(idempotencyKeys.key, key));

    expect(await service.reserve(key)).toBe(false);
    expect(await service.reserve(key, { leaseMs: 60_000 })).toBe(true);
    // The reclaim restarted the lease, so an immediate second reclaim is a duplicate.
    expect(await service.reserve(key, { leaseMs: 60_000 })).toBe(false);
  });
});
