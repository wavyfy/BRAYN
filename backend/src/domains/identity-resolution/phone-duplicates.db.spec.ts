import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { integrations } from '../../database/schema/integrations';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { canonicalCustomerDuplicates } from '../../database/schema/canonical-customer-duplicates';
import { CustomerService, type NormalizedCustomer } from '../commerce/customer.service';
import { IdentityResolutionService } from './identity-resolution.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

/**
 * E.164 phone duplicate detection against the real dev DB: CustomerService
 * stores raw + E.164 phone, IdentityResolutionService flags shared E.164
 * phones across different canonical customers — tenant-scoped, idempotent,
 * and re-checked when a phone changes. Two throwaway workspaces, deleted in
 * afterAll.
 */
// Every step is a real Neon round trip (~250ms each), so the default 5s per-test budget is too tight.
describe('Phone duplicate detection (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let customers: CustomerService;
  let identity: IdentityResolutionService;

  const ws = { a: randomUUID(), b: randomUUID() };
  const integrationIds: Record<string, string> = {};
  const key = (workspaceId: string, provider: IntegrationProvider) => `${workspaceId}:${provider}`;

  const customer = (externalId: string, email: string, phone: string | null): NormalizedCustomer => ({
    externalId,
    email,
    firstName: null,
    lastName: null,
    phone,
    sourceUpdatedAt: null,
    sourceCreatedAt: null,
  });

  async function sync(workspaceId: string, provider: IntegrationProvider, batch: NormalizedCustomer[]) {
    await customers.upsertMany(workspaceId, integrationIds[key(workspaceId, provider)], provider, batch);
    await identity.resolveMany(
      workspaceId,
      provider,
      batch.map((c) => c.externalId),
    );
  }

  const row = async (workspaceId: string, provider: IntegrationProvider, externalId: string) =>
    (
      await db.client
        .select()
        .from(commerceCustomers)
        .where(
          and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.provider, provider), eq(commerceCustomers.externalId, externalId)),
        )
    )[0];
  const duplicates = (workspaceId: string) =>
    db.client.select().from(canonicalCustomerDuplicates).where(eq(canonicalCustomerDuplicates.workspaceId, workspaceId));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    customers = moduleRef.get(CustomerService);
    identity = moduleRef.get(IdentityResolutionService);

    for (const workspaceId of [ws.a, ws.b]) {
      await db.client.insert(workspaces).values({ id: workspaceId, name: 'Phone Duplicates Test Workspace' });
      for (const provider of ['shopify', 'woocommerce'] as const) {
        const [integration] = await db.client.insert(integrations).values({ workspaceId, provider }).returning({ id: integrations.id });
        integrationIds[key(workspaceId, provider)] = integration.id;
      }
    }
  }, 60_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [ws.a, ws.b];
    await db.client.delete(canonicalCustomerDuplicates).where(inArray(canonicalCustomerDuplicates.workspaceId, ids));
    await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
    await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
    await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    await moduleRef?.close();
  }, 60_000);

  it('flags the same number in different formats across providers as one pair, keyed on E.164, keeping the raw phone', async () => {
    await sync(ws.a, 'shopify', [customer('s1', 'ada@example.com', '+1 (415) 555-2671')]);
    await sync(ws.a, 'woocommerce', [customer('w1', 'grace@example.com', '001-415-555-2671')]);

    const shopifyRow = await row(ws.a, 'shopify', 's1');
    const wooRow = await row(ws.a, 'woocommerce', 'w1');
    expect(shopifyRow).toMatchObject({ phone: '+1 (415) 555-2671', phoneE164: '+14155552671' });
    expect(wooRow).toMatchObject({ phone: '001-415-555-2671', phoneE164: '+14155552671' });

    const flagged = await duplicates(ws.a);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({ matchedSignal: 'phone', matchedValue: '+14155552671', status: 'pending' });
    expect([flagged[0].canonicalCustomerAId, flagged[0].canonicalCustomerBId].sort()).toEqual(
      [shopifyRow.canonicalCustomerId, wooRow.canonicalCustomerId].sort(),
    );
  });

  it('is idempotent: re-syncing the same customers adds no duplicate rows', async () => {
    await sync(ws.a, 'shopify', [customer('s1', 'ada@example.com', '+1 (415) 555-2671')]);
    await sync(ws.a, 'woocommerce', [customer('w1', 'grace@example.com', '001-415-555-2671')]);

    expect(await duplicates(ws.a)).toHaveLength(1);
  });

  it('never matches national-only numbers, even with identical digits', async () => {
    await sync(ws.a, 'woocommerce', [customer('w2', 'linus@example.com', '9876543210'), customer('w3', 'ken@example.com', '98765 43210')]);

    expect((await row(ws.a, 'woocommerce', 'w2')).phoneE164).toBeNull();
    expect((await row(ws.a, 'woocommerce', 'w3')).phoneE164).toBeNull();
    expect(await duplicates(ws.a)).toHaveLength(1);
  });

  it('detects a duplicate when an already-linked customer’s phone changes on a later sync', async () => {
    await sync(ws.a, 'woocommerce', [customer('w4', 'barbara@example.com', null)]);
    const before = await row(ws.a, 'woocommerce', 'w4');
    expect(before.canonicalCustomerId).not.toBeNull();
    expect(await duplicates(ws.a)).toHaveLength(1);

    await sync(ws.a, 'woocommerce', [customer('w4', 'barbara@example.com', '+14155552671')]);

    const after = await row(ws.a, 'woocommerce', 'w4');
    expect(after.canonicalCustomerId).toBe(before.canonicalCustomerId);
    const pairsWithW4 = (await duplicates(ws.a)).filter(
      (d) => d.canonicalCustomerAId === after.canonicalCustomerId || d.canonicalCustomerBId === after.canonicalCustomerId,
    );
    expect(pairsWithW4).toHaveLength(2);
    expect(pairsWithW4.every((d) => d.matchedValue === '+14155552671')).toBe(true);
  });

  it('keeps detection tenant-scoped: the same number in another workspace is never paired across workspaces', async () => {
    await sync(ws.b, 'shopify', [customer('s1', 'ada@example.com', '+14155552671')]);

    expect(await duplicates(ws.b)).toHaveLength(0);
    const bCanonical = (await row(ws.b, 'shopify', 's1')).canonicalCustomerId;
    const crossed = (await duplicates(ws.a)).filter((d) => d.canonicalCustomerAId === bCanonical || d.canonicalCustomerBId === bCanonical);
    expect(crossed).toHaveLength(0);
  });
});
