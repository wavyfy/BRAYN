import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { ProviderError } from '../common/errors/app-error';
import type { Env } from '../config/env.schema';

/**
 * Thin wrapper around the Drizzle/node-postgres connection. Lazily
 * connects on first real use rather than at app boot, so the rest of the
 * app still starts cleanly when DATABASE_URL isn't configured yet (see
 * "29. BRAYN Technology Stack" §8-9 — PostgreSQL via Neon, Drizzle ORM).
 *
 * Fails closed with ProviderError when something tries to use the
 * database without it being configured, matching AuthGuard's pattern
 * from Step 4 rather than silently no-op-ing.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool?: Pool;
  private db?: NodePgDatabase;

  constructor(private readonly config: ConfigService<Env, true>) {}

  isConfigured(): boolean {
    return Boolean(this.config.get('DATABASE_URL', { infer: true }));
  }

  get client(): NodePgDatabase {
    return this.connect().db;
  }

  async transaction<T>(fn: (tx: NodePgDatabase) => Promise<T>): Promise<T> {
    const { db } = this.connect();
    // drizzle's transaction callback receives a transaction-scoped query
    // builder that shares the same query API surface as the top-level db.
    return db.transaction((tx) => fn(tx as unknown as NodePgDatabase));
  }

  async ping(): Promise<void> {
    const { pool } = this.connect();
    await pool.query('SELECT 1');
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
  }

  private connect(): { pool: Pool; db: NodePgDatabase } {
    const connectionString = this.config.get('DATABASE_URL', { infer: true });
    if (!connectionString) {
      throw new ProviderError('Database is not configured.');
    }

    if (!this.pool || !this.db) {
      this.pool = new Pool({ connectionString });
      this.db = drizzle(this.pool);
    }

    return { pool: this.pool, db: this.db };
  }
}
