import { Injectable } from '@nestjs/common';
import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { idempotencyKeys } from '../../database/schema/idempotency-keys';

/**
 * Lease for request-scoped ingestion paths (webhook/website ingest) — far
 * longer than their synchronous work (a handful of DB round trips), short
 * enough that a crashed attempt's key is reclaimable by the provider's
 * next retry.
 */
export const INGEST_IDEMPOTENCY_LEASE_MS = 60_000;

export interface ReserveOptions {
  /**
   * When set, a `pending` reservation older than this is treated as
   * abandoned (its holder crashed before `complete()`/`fail()`) and can be
   * reclaimed. Omitted → a `pending` key is never reclaimed, only a
   * `failed` one (AiActionControlService relies on this: a failed action's
   * key deliberately stays blocked).
   */
  leaseMs?: number;
}

/**
 * Idempotency foundation (doc 07, doc 03 rule 5).
 *
 * pending ──complete()──▶ completed   (terminal: always a duplicate)
 *    │
 *    └──fail()──▶ failed ──reserve()──▶ pending   (retry allowed)
 *    └──lease expired (opt-in)──reserve()──▶ pending   (crash recovery)
 *
 * `reserve()` is one atomic INSERT ... ON CONFLICT DO UPDATE ... WHERE
 * <reclaimable>: Postgres row-locks the conflicting row and re-evaluates
 * the WHERE against its latest committed version, so among concurrent
 * callers on the same key exactly one gets a row back. Rows are never
 * deleted, so there's no delete-then-insert window for two callers to
 * both win.
 *
 * ponytail: no fencing token — if a holder outlives its lease and another
 * caller reclaims the key, the first holder's later complete()/fail()
 * still applies to the shared row. Leases are sized far above real
 * processing time; add a per-reservation token if a caller ever needs
 * leases close to its processing time.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly database: DatabaseService) {}

  /** Returns true if this call newly reserved (or reclaimed) the key, false if it's completed or held by another live attempt. */
  async reserve(key: string, options: ReserveOptions = {}): Promise<boolean> {
    const reclaimable: SQL[] = [eq(idempotencyKeys.status, 'failed')];
    if (options.leaseMs !== undefined) {
      reclaimable.push(
        and(
          eq(idempotencyKeys.status, 'pending'),
          sql`${idempotencyKeys.reservedAt} < now() - ${options.leaseMs} * interval '1 millisecond'`,
        )!,
      );
    }

    const rows = await this.database.client
      .insert(idempotencyKeys)
      .values({ key })
      .onConflictDoUpdate({
        target: idempotencyKeys.key,
        set: { status: 'pending', reservedAt: sql`now()`, completedAt: null },
        setWhere: or(...reclaimable),
      })
      .returning({ key: idempotencyKeys.key });

    return rows.length > 0;
  }

  async complete(key: string): Promise<void> {
    await this.database.client
      .update(idempotencyKeys)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(idempotencyKeys.key, key));
  }

  /** Releases a failed attempt so a retry can re-reserve the key. Never downgrades a completed key. */
  async fail(key: string): Promise<void> {
    await this.database.client
      .update(idempotencyKeys)
      .set({ status: 'failed' })
      .where(and(eq(idempotencyKeys.key, key), eq(idempotencyKeys.status, 'pending')));
  }

  /** Distinguishes "already done" from "another attempt holds it right now" after reserve() returned false. */
  async isCompleted(key: string): Promise<boolean> {
    const [row] = await this.database.client
      .select({ status: idempotencyKeys.status })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .limit(1);

    return row?.status === 'completed';
  }
}
