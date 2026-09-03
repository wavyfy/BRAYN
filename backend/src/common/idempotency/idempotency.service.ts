import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { idempotencyKeys } from '../../database/schema/idempotency-keys';

/**
 * Idempotency foundation (doc 07, doc 03 rule 5). `reserve()` atomically
 * claims a key via INSERT ... ON CONFLICT DO NOTHING — Postgres-native,
 * safe under concurrent callers racing on the same key, no separate lock
 * needed.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly database: DatabaseService) {}

  /** Returns true if this call newly reserved the key, false if it was already claimed. */
  async reserve(key: string): Promise<boolean> {
    const rows = await this.database.client
      .insert(idempotencyKeys)
      .values({ key })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });

    return rows.length > 0;
  }

  async complete(key: string): Promise<void> {
    await this.database.client
      .update(idempotencyKeys)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(idempotencyKeys.key, key));
  }
}
