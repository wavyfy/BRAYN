import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseService } from './database.service';

/**
 * ignoreEnvFile is required here: ConfigModule.forRoot() reloads
 * backend/.env by default, which would silently repopulate
 * DATABASE_URL after a test deletes it from process.env — making these
 * "not configured" tests actually hit the real database whenever a real
 * .env is present (as it is from Step 5 onward).
 */
async function buildService(ignoreEnvFile: boolean): Promise<DatabaseService> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile })],
    providers: [DatabaseService],
  }).compile();

  return moduleRef.get(DatabaseService);
}

describe('DatabaseService — not configured', () => {
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalUrl;
  });

  it('reports isConfigured() as false', async () => {
    const service = await buildService(true);
    expect(service.isConfigured()).toBe(false);
  });

  it('fails closed on ping() rather than silently no-op-ing', async () => {
    const service = await buildService(true);
    await expect(service.ping()).rejects.toThrow('Database is not configured.');
  });

  it('fails closed on client access', async () => {
    const service = await buildService(true);
    expect(() => service.client).toThrow('Database is not configured.');
  });

  it('fails closed on transaction()', async () => {
    const service = await buildService(true);
    await expect(service.transaction(async (tx) => tx)).rejects.toThrow(
      'Database is not configured.',
    );
  });
});

describe('DatabaseService — configured', () => {
  const originalUrl = process.env.DATABASE_URL;

  beforeEach(() => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/brayn_test';
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalUrl;
  });

  it('reports isConfigured() as true', async () => {
    const service = await buildService(true);
    expect(service.isConfigured()).toBe(true);
  });
});
