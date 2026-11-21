import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfiguration } from '../../../../config/configuration';
import { DatabaseModule } from '../../../../database/database.module';
import { DatabaseService } from '../../../../database/database.service';
import { withExclusiveMigrationLock } from './shopify-webhook-migration.service';

describe('withExclusiveMigrationLock (real DB)', () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [loadConfiguration] }),
        DatabaseModule,
      ],
    }).compile();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error(
        'DATABASE_URL is not configured — this integration test requires a real database.',
      );
    }
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('lets one holder in at a time (others get a 409 immediately) and releases the lock when the holder finishes', async () => {
    let release!: () => void;
    let entered!: () => void;
    const holderInside = new Promise<void>((resolve) => (entered = resolve));
    const holder = withExclusiveMigrationLock(db, async () => {
      entered();
      await new Promise<void>((resolve) => (release = resolve));
      return 'first';
    });
    await holderInside;

    await expect(withExclusiveMigrationLock(db, async () => 'second')).rejects.toMatchObject({
      message: expect.stringContaining('Another Shopify webhook subscription migration is running'),
      status: 409,
    });

    release();
    await expect(holder).resolves.toBe('first');
    await expect(withExclusiveMigrationLock(db, async () => 'third')).resolves.toBe('third');
  }, 30_000);

  it('releases the lock when the work throws', async () => {
    await expect(
      withExclusiveMigrationLock(db, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(withExclusiveMigrationLock(db, async () => 'after')).resolves.toBe('after');
  }, 30_000);
});
