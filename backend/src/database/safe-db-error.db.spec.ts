import { inspect } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { DrizzleQueryError, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfiguration } from '../config/configuration';
import { AllExceptionsFilter } from '../common/errors/all-exceptions.filter';
import { StructuredLoggerService } from '../common/logging/structured-logger.service';
import { scrubSensitive } from '../common/logging/scrub-sensitive';
import { DatabaseModule } from './database.module';
import { DatabaseService } from './database.service';
import { workspaces } from './schema/workspaces';

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('../common/observability/sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../common/observability/sentry')>()),
  captureException,
}));

/** Customer data that must never leave the database layer through an error. */
const EMAIL = `leak.${randomUUID().slice(0, 8)}@example.com`;
const PHONE = '+919812345678';
const LEAKS = [EMAIL, PHONE, 'Failed query', 'params:', 'insert into', 'select '];

function expectNoLeak(text: string) {
  for (const leak of LEAKS) expect(text, `leaked "${leak}"`).not.toContain(leak);
}

/** Every way a BRAYN sink turns an error into text (logs, stored error/reason columns, AI tool results, Sentry). */
function sinkRenderings(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  return [
    message,
    String(error),
    scrubSensitive(message),
    JSON.stringify({ error: message }),
    inspect(error, { depth: 5 }),
    (error as Error).stack ?? '',
    String((error as { detail?: string }).detail ?? ''),
  ];
}

describe('database errors never carry SQL or customer data (real DB, drizzle-orm 0.45)', () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [loadConfiguration] }), DatabaseModule],
    }).compile();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  async function caught(run: () => Promise<unknown>): Promise<Error & Record<string, unknown>> {
    try {
      await run();
    } catch (error) {
      return error as Error & Record<string, unknown>;
    }
    throw new Error('expected the query to fail');
  }

  it('a unique violation surfaces as the driver error with its code, values redacted, and the transaction rolled back', async () => {
    const marker = `safe-db-error ${randomUUID()}`;
    const error = await caught(() =>
      db.transaction(async (tx) => {
        await tx.insert(workspaces).values({ name: marker });
        await tx.execute(sql`create temporary table safe_db_error_probe (email text unique, phone text) on commit drop`);
        await tx.execute(sql`insert into safe_db_error_probe values (${EMAIL}, ${PHONE})`);
        await tx.execute(sql`insert into safe_db_error_probe values (${EMAIL}, ${PHONE})`);
      }),
    );

    expect(error).not.toBeInstanceOf(DrizzleQueryError);
    expect(error.code).toBe('23505');
    expect(error.constraint).toBe('safe_db_error_probe_email_key');
    expect(error.message).toBe('duplicate key value violates unique constraint "safe_db_error_probe_email_key"');
    expect(error.detail).toBe('Key (email)=([redacted]) already exists.');
    for (const text of sinkRenderings(error)) expectNoLeak(text);

    // Rolled back: the workspace inserted earlier in the same transaction is gone.
    expect(await db.client.select().from(workspaces).where(eq(workspaces.name, marker))).toEqual([]);
  });

  it('an invalid-input error from a top-level query does not echo the bound value', async () => {
    const error = await caught(() => db.client.execute(sql`select ${EMAIL}::uuid`));
    expect(error.code).toBe('22P02');
    expect(error.message).toBe('invalid input syntax for type uuid: "[redacted]"');
    for (const text of sinkRenderings(error)) expectNoLeak(text);
  });

  it('a builder query (select … where email = $1) failing keeps the code and no values', async () => {
    const error = await caught(() => db.client.select().from(workspaces).where(sql`${workspaces.id} = ${EMAIL}::uuid`));
    expect(error.code).toBe('22P02');
    for (const text of sinkRenderings(error)) expectNoLeak(text);
  });

  describe('through the API exception filter', () => {
    let app: NestFastifyApplication;
    const logged: string[] = [];

    @Controller('probe')
    class ProbeController {
      @Get()
      async probe() {
        await db.client.execute(sql`select ${EMAIL}::uuid, ${PHONE}`);
      }
    }

    beforeAll(async () => {
      const ref = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
      app = ref.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      const logger = new StructuredLoggerService();
      // StructuredLoggerService writes JSON lines via console.log / console.error.
      for (const method of ['log', 'error'] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(' '));
        });
      }
      app.useGlobalFilters(new AllExceptionsFilter(logger));
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      vi.restoreAllMocks();
      await app.close();
    });

    it('API response, log lines and the Sentry capture carry no SQL or values', async () => {
      const res = await app.inject({ method: 'GET', url: '/probe' });

      expect(res.statusCode).toBe(500);
      expectNoLeak(res.body);
      expect(logged.join('')).toContain('invalid input syntax for type uuid');
      expectNoLeak(logged.join(''));
      expect(captureException).toHaveBeenCalledTimes(1);
      const captured = captureException.mock.calls[0][0] as Error & { code?: string };
      expect(captured).not.toBeInstanceOf(DrizzleQueryError);
      expect(captured.code).toBe('22P02');
      for (const text of sinkRenderings(captured)) expectNoLeak(text);
    });
  });
});
