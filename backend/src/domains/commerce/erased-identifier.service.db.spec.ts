import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { eq, inArray } from 'drizzle-orm';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { loadConfiguration } from '../../config/configuration';
import type { Env } from '../../config/env.schema';
import { workspaces } from '../../database/schema/workspaces';
import { erasedCustomerIdentifiers } from '../../database/schema/erased-customer-identifiers';
import { ServiceUnavailableError } from '../../common/errors/app-error';
import { ErasedIdentifierService, emailIdentifier, orderIdentifier, sourceIdentifier } from './erased-identifier.service';

/** Block-list hashing, isolation and fail-closed behaviour against the real dev DB. */
describe('ErasedIdentifierService (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  const wsA = randomUUID();
  const wsB = randomUUID();
  const SECRET = 'a'.repeat(64);
  const withSecret = (secret: string | undefined) =>
    new ErasedIdentifierService({ get: (key: string) => (key === 'ERASURE_HMAC_SECRET' ? secret : undefined) } as unknown as ConfigService<Env, true>);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, load: [loadConfiguration] }), DatabaseModule] }).compile();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    await db.client.insert(workspaces).values([
      { id: wsA, name: 'Erased Identifier Test A' },
      { id: wsB, name: 'Erased Identifier Test B' },
    ]);
  });

  afterAll(async () => {
    if (db?.isConfigured()) {
      await db.client.delete(erasedCustomerIdentifiers).where(inArray(erasedCustomerIdentifiers.workspaceId, [wsA, wsB]));
      await db.client.delete(workspaces).where(inArray(workspaces.id, [wsA, wsB]));
    }
    await moduleRef?.close();
  });

  it('normalizes emails and builds distinct kinds', () => {
    expect(emailIdentifier('  Gia@Example.COM ')).toEqual({ kind: 'email', value: 'gia@example.com' });
    expect(emailIdentifier('  ')).toBeNull();
    expect(sourceIdentifier('woocommerce', '7')).not.toEqual(orderIdentifier('woocommerce', '7'));
  });

  it('records identifiers as HMACs only, blocks them in that workspace only, and is idempotent', async () => {
    const service = withSecret(SECRET);
    const ids = [emailIdentifier('gia@example.com')!, sourceIdentifier('woocommerce', '7'), orderIdentifier('woocommerce', '901')];

    await db.transaction((tx) => service.record(tx, wsA, ids));
    await db.transaction((tx) => service.record(tx, wsA, ids));

    const rows = await db.client.select().from(erasedCustomerIdentifiers).where(eq(erasedCustomerIdentifiers.workspaceId, wsA));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.valueHmac).toMatch(/^[0-9a-f]{64}$/);
      expect(row.valueHmac).not.toContain('gia');
    }
    const blockedInA = await db.transaction((tx) => service.findBlocked(tx, wsA, [...ids, sourceIdentifier('woocommerce', '8'), sourceIdentifier('shopify', '7'), null]));
    expect(ids.map(blockedInA)).toEqual([true, true, true]);
    expect(blockedInA(sourceIdentifier('woocommerce', '8'))).toBe(false);
    expect(blockedInA(sourceIdentifier('shopify', '7'))).toBe(false);
    expect(blockedInA(orderIdentifier('woocommerce', '7'))).toBe(false); // same value, different kind
    expect(blockedInA(null)).toBe(false);

    const blockedInB = await db.transaction((tx) => service.findBlocked(tx, wsB, ids));
    expect(ids.map(blockedInB)).toEqual([false, false, false]);
  });

  it('a workspace with nothing erased needs no secret at all', async () => {
    const blocked = await db.transaction((tx) => withSecret(undefined).findBlocked(tx, wsB, [emailIdentifier('x@example.com')]));
    expect(blocked(emailIdentifier('x@example.com'))).toBe(false);
  });

  it('fails closed: missing secret or a different secret with erased rows present throws instead of letting data in', async () => {
    const ids = [emailIdentifier('gia@example.com')];
    await expect(db.transaction((tx) => withSecret(undefined).findBlocked(tx, wsA, ids))).rejects.toThrow(/not configured/);
    await expect(db.transaction((tx) => withSecret('b'.repeat(64)).findBlocked(tx, wsA, ids))).rejects.toThrow(/different ERASURE_HMAC_SECRET/);
  });

  it('erasure refuses to run without a secret (503)', async () => {
    expect(() => withSecret(undefined).requireConfigured()).toThrow(ServiceUnavailableError);
    await expect(db.transaction((tx) => withSecret(undefined).record(tx, wsB, [emailIdentifier('y@example.com')!]))).rejects.toBeInstanceOf(ServiceUnavailableError);
  });
});
