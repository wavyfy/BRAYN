import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { users } from '../../database/schema/users';
import { integrations } from '../../database/schema/integrations';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { canonicalCustomerDuplicates } from '../../database/schema/canonical-customer-duplicates';
import { identityMergeHistory } from '../../database/schema/identity-merge-history';
import { customerPreferenceHistory, customerPreferences } from '../../database/schema/customer-preferences';
import { RequestContext } from '../../common/logging/request-context';
import { CustomerService, type NormalizedCustomer } from '../commerce/customer.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { IntegrationService } from '../integration/integration.service';
import { CustomerIntelligenceService } from './customer-intelligence.service';
import { CustomerPreferenceService } from './customer-preference.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

/**
 * Slice 4.2 merchant-provided customer preferences against the real dev
 * DB: provenance, category, create/edit/archive + history, tenant
 * isolation, merged customers, re-association on identity merge (incl.
 * rollback), erasure, and preferences staying out of the UCIR reads AI
 * agents consume. Two
 * throwaway workspaces + two throwaway users, deleted in afterAll.
 */
// Every step is a real Neon round trip (~250ms each), so the default 5s per-test budget is too tight.
describe('Customer preferences (real DB)', { timeout: 90_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let customers: CustomerService;
  let identity: IdentityResolutionService;
  let intelligence: CustomerIntelligenceService;
  let preferences: CustomerPreferenceService;
  let integrationService: IntegrationService;

  const ws = { a: randomUUID(), b: randomUUID() };
  const integrationIds: Record<string, string> = {};
  let adminUserId = '';
  let otherAdminUserId = '';

  const customer = (externalId: string, email: string | null, phone: string | null = null): NormalizedCustomer => ({
    externalId,
    email,
    firstName: null,
    lastName: null,
    phone,
    sourceUpdatedAt: null,
    sourceCreatedAt: null,
  });
  async function sync(workspaceId: string, provider: IntegrationProvider, batch: NormalizedCustomer[]) {
    await customers.upsertMany(workspaceId, integrationIds[`${workspaceId}:${provider}`], provider, batch);
    await identity.resolveMany(
      workspaceId,
      provider,
      batch.map((c) => c.externalId),
    );
  }
  const linkOf = async (workspaceId: string, provider: IntegrationProvider, externalId: string) =>
    (
      await db.client
        .select()
        .from(commerceCustomers)
        .where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.provider, provider), eq(commerceCustomers.externalId, externalId)))
    )[0]?.canonicalCustomerId as string;
  const as = <T>(userId: string, workspaceId: string, fn: () => Promise<T>) =>
    RequestContext.run({ correlationId: randomUUID(), workspaceId, actorUserId: userId, actorRole: 'admin' }, fn);
  const asAdmin = <T>(workspaceId: string, fn: () => Promise<T>) => as(adminUserId, workspaceId, fn);
  const entry = async (id: string) => (await db.client.select().from(customerPreferences).where(eq(customerPreferences.id, id)))[0];
  const historyOf = (id: string) =>
    db.client.select().from(customerPreferenceHistory).where(eq(customerPreferenceHistory.preferenceId, id)).orderBy(asc(customerPreferenceHistory.changedAt));
  const phonePairIn = async (workspaceId: string) =>
    (
      await db.client
        .select()
        .from(canonicalCustomerDuplicates)
        .where(and(eq(canonicalCustomerDuplicates.workspaceId, workspaceId), eq(canonicalCustomerDuplicates.matchedSignal, 'phone')))
    )[0];

  // Workspace A: a plain customer for lifecycle checks.
  let customerA = '';

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    customers = moduleRef.get(CustomerService);
    identity = moduleRef.get(IdentityResolutionService);
    intelligence = moduleRef.get(CustomerIntelligenceService);
    preferences = moduleRef.get(CustomerPreferenceService);
    integrationService = moduleRef.get(IntegrationService);

    for (const workspaceId of [ws.a, ws.b]) {
      await db.client.insert(workspaces).values({ id: workspaceId, name: 'Customer Preference Test Workspace' });
      for (const provider of ['shopify', 'woocommerce'] as const) {
        const [integration] = await db.client.insert(integrations).values({ workspaceId, provider }).returning({ id: integrations.id });
        integrationIds[`${workspaceId}:${provider}`] = integration.id;
      }
    }
    [{ id: adminUserId }] = await db.client.insert(users).values({ clerkUserId: `test_preference_${randomUUID()}` }).returning({ id: users.id });
    [{ id: otherAdminUserId }] = await db.client.insert(users).values({ clerkUserId: `test_preference_${randomUUID()}` }).returning({ id: users.id });

    await sync(ws.a, 'shopify', [customer('a1', 'ada@example.com')]);
    customerA = await linkOf(ws.a, 'shopify', 'a1');
  }, 90_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [ws.a, ws.b];
    await db.client.delete(customerPreferenceHistory).where(inArray(customerPreferenceHistory.workspaceId, ids));
    await db.client.delete(customerPreferences).where(inArray(customerPreferences.workspaceId, ids));
    await db.client.delete(identityMergeHistory).where(inArray(identityMergeHistory.workspaceId, ids));
    await db.client.delete(canonicalCustomerDuplicates).where(inArray(canonicalCustomerDuplicates.workspaceId, ids));
    await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
    await db.client.update(canonicalCustomers).set({ mergedIntoId: null }).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
    await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    for (const userId of [adminUserId, otherAdminUserId]) {
      if (userId) await db.client.delete(users).where(eq(users.id, userId));
    }
    await moduleRef?.close();
  }, 60_000);

  it('creates a merchant_provided preference with its creator and a "created" history row — provenance cannot be chosen by the caller', async () => {
    const created = await asAdmin(ws.a, () => preferences.create(ws.a, customerA, { category: 'communication', content: 'Prefers weekend delivery' }));
    expect(created).toMatchObject({ workspaceId: ws.a, canonicalCustomerId: customerA, provenance: 'merchant_provided', status: 'active', createdByUserId: adminUserId, archivedAt: null });

    // Even if something bypassed the DTO, the service never stores another provenance.
    const forced = await asAdmin(ws.a, () => preferences.create(ws.a, customerA, { category: 'product', content: 'Forced', provenance: 'ai_generated' } as never));
    expect((await entry(forced.id)).provenance).toBe('merchant_provided');

    expect(await historyOf(created.id)).toEqual([
      expect.objectContaining({ action: 'created', content: 'Prefers weekend delivery', provenance: 'merchant_provided', status: 'active', changedByUserId: adminUserId, workspaceId: ws.a }),
    ]);
    expect((await asAdmin(ws.a, () => preferences.list(ws.a, customerA))).map((e) => e.id)).toEqual([forced.id, created.id]);
  });

  it('edits category and content, keeps the original creator/createdAt, and records who edited', async () => {
    const created = await asAdmin(ws.a, () => preferences.create(ws.a, customerA, { category: 'communication', content: 'Allergic to wool' }));
    const edited = await as(otherAdminUserId, ws.a, () => preferences.update(ws.a, customerA, created.id, { category: 'product', content: 'Allergic to wool and silk' }));

    expect(edited).toMatchObject({ id: created.id, category: 'product', content: 'Allergic to wool and silk', createdByUserId: adminUserId, provenance: 'merchant_provided', status: 'active' });
    expect(edited.createdAt.getTime()).toBe(created.createdAt.getTime());
    expect(edited.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
    expect((await historyOf(created.id)).map((h) => [h.action, h.category, h.content, h.changedByUserId])).toEqual([
      ['created', 'communication', 'Allergic to wool', adminUserId],
      ['edited', 'product', 'Allergic to wool and silk', otherAdminUserId],
    ]);
  });

  it('archives (never deletes): hidden from the list, kept in the table, history recorded, further edits/archives refused', async () => {
    const created = await asAdmin(ws.a, () => preferences.create(ws.a, customerA, { category: 'communication', content: 'Temporary note' }));
    const archived = await asAdmin(ws.a, () => preferences.archive(ws.a, customerA, created.id));

    expect(archived).toMatchObject({ id: created.id, status: 'archived', content: 'Temporary note' });
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect((await asAdmin(ws.a, () => preferences.list(ws.a, customerA))).map((e) => e.id)).not.toContain(created.id);
    expect(await entry(created.id)).toBeDefined();
    expect((await historyOf(created.id)).map((h) => [h.action, h.status])).toEqual([
      ['created', 'active'],
      ['archived', 'archived'],
    ]);

    await expect(asAdmin(ws.a, () => preferences.update(ws.a, customerA, created.id, { content: 'x' }))).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(asAdmin(ws.a, () => preferences.archive(ws.a, customerA, created.id))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await historyOf(created.id)).toHaveLength(2);
  });

  it('isolates tenants and customers: another workspace, another customer, or an unknown/non-uuid id is a 404 that changes nothing', async () => {
    const created = await asAdmin(ws.a, () => preferences.create(ws.a, customerA, { category: 'communication', content: 'Workspace A only' }));
    await sync(ws.a, 'shopify', [customer('a2', 'bob@example.com')]);
    const otherCustomer = await linkOf(ws.a, 'shopify', 'a2');

    await expect(asAdmin(ws.b, () => preferences.list(ws.b, customerA))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(asAdmin(ws.b, () => preferences.create(ws.b, customerA, { category: 'communication', content: 'x' }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(asAdmin(ws.b, () => preferences.update(ws.b, customerA, created.id, { content: 'x' }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(asAdmin(ws.b, () => preferences.archive(ws.b, customerA, created.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(asAdmin(ws.a, () => preferences.update(ws.a, otherCustomer, created.id, { content: 'x' }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(asAdmin(ws.a, () => preferences.archive(ws.a, customerA, randomUUID()))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(asAdmin(ws.a, () => preferences.archive(ws.a, customerA, 'not-a-uuid'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(asAdmin(ws.a, () => preferences.list(ws.a, 'not-a-uuid'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await asAdmin(ws.a, () => preferences.list(ws.a, otherCustomer))).toEqual([]);

    expect(await entry(created.id)).toMatchObject({ content: 'Workspace A only', status: 'active', canonicalCustomerId: customerA });
    expect(await historyOf(created.id)).toHaveLength(1);
    expect(await db.client.select().from(customerPreferences).where(eq(customerPreferences.workspaceId, ws.b))).toHaveLength(0);
  });

  it('refuses writes without an authenticated actor', async () => {
    await expect(preferences.create(ws.a, customerA, { category: 'communication', content: 'x' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('keeps preferences out of the UCIR reads AI agents consume (getCustomer / getActivity)', async () => {
    const secret = `preference-not-for-ai-${randomUUID()}`;
    await asAdmin(ws.a, () => preferences.create(ws.a, customerA, { category: 'communication', content: secret }));

    const record = await intelligence.getCustomer(ws.a, customerA);
    const activity = await intelligence.getActivity(ws.a, customerA);
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(activity)).not.toContain(secret);
    expect(Object.keys(record)).not.toContain('preferences');
  });

  describe('identity merge', () => {
    let survivor = '';
    let merged = '';
    let activeOnMerged = '';
    let archivedOnMerged = '';
    let onSurvivor = '';
    let pairA = '';

    beforeAll(async () => {
      // Workspace B: survivor (older, Shopify) and merged (newer, WooCommerce) share a phone.
      await sync(ws.b, 'shopify', [customer('s1', 'sam@example.com', '+14155550199')]);
      await sync(ws.b, 'woocommerce', [customer('w1', 'sammy@example.com', '+1 415 555 0199')]);
      survivor = await linkOf(ws.b, 'shopify', 's1');
      merged = await linkOf(ws.b, 'woocommerce', 'w1');
      pairA = (await phonePairIn(ws.b)).id;

      ({ id: onSurvivor } = await asAdmin(ws.b, () => preferences.create(ws.b, survivor, { category: 'communication', content: 'Survivor note' })));
      ({ id: activeOnMerged } = await as(otherAdminUserId, ws.b, () => preferences.create(ws.b, merged, { category: 'communication', content: 'Merged side note' })));
      await asAdmin(ws.b, () => preferences.update(ws.b, merged, activeOnMerged, { content: 'Merged side note, edited' }));
      ({ id: archivedOnMerged } = await asAdmin(ws.b, () => preferences.create(ws.b, merged, { category: 'communication', content: 'Merged archived note' })));
      await asAdmin(ws.b, () => preferences.archive(ws.b, merged, archivedOnMerged));
    }, 90_000);

    it('rolls back preference re-association when the merge fails at its last write', async () => {
      const before = await entry(activeOnMerged);
      const original = db.transaction.bind(db);
      const spy = vi.spyOn(db, 'transaction').mockImplementation((fn) =>
        original((tx) => {
          const failing = new Proxy(tx, {
            get(target, prop, receiver) {
              if (prop !== 'update') return Reflect.get(target, prop, receiver);
              return (table: unknown) => {
                if (table === canonicalCustomers) throw new Error('injected failure');
                return target.update(table as never);
              };
            },
          }) as NodePgDatabase;
          return fn(failing);
        }),
      );
      try {
        await expect(asAdmin(ws.b, () => identity.merge(ws.b, pairA))).rejects.toThrow('injected failure');
      } finally {
        spy.mockRestore();
      }

      expect(await entry(activeOnMerged)).toEqual(before);
      expect((await entry(archivedOnMerged)).canonicalCustomerId).toBe(merged);
      expect(await db.client.select().from(identityMergeHistory).where(eq(identityMergeHistory.workspaceId, ws.b))).toHaveLength(0);
    });

    it('re-associates every preference with the survivor unchanged and records prior ownership in the merge history', async () => {
      const before = await Promise.all([activeOnMerged, archivedOnMerged].map(entry));
      const historyCounts = await Promise.all([activeOnMerged, archivedOnMerged].map(async (id) => (await historyOf(id)).length));

      const result = await asAdmin(ws.b, () => identity.merge(ws.b, pairA));
      expect(result).toMatchObject({ survivingCanonicalCustomerId: survivor, mergedCanonicalCustomerId: merged });

      const after = await Promise.all([activeOnMerged, archivedOnMerged].map(entry));
      after.forEach((row, i) => expect(row).toEqual({ ...before[i], canonicalCustomerId: survivor }));
      expect(after[0]).toMatchObject({ content: 'Merged side note, edited', provenance: 'merchant_provided', createdByUserId: otherAdminUserId, status: 'active' });
      expect(after[1].status).toBe('archived');
      // No copies, no extra history rows.
      expect(await db.client.select().from(customerPreferences).where(eq(customerPreferences.workspaceId, ws.b))).toHaveLength(3);
      expect(await Promise.all([activeOnMerged, archivedOnMerged].map(async (id) => (await historyOf(id)).length))).toEqual(historyCounts);

      const [history] = await db.client.select().from(identityMergeHistory).where(eq(identityMergeHistory.id, result.mergeHistoryId));
      expect([...(history.snapshot.merged.preferenceIds ?? [])].sort()).toEqual([activeOnMerged, archivedOnMerged].sort());
      expect(history.snapshot.surviving.preferenceIds).toEqual([onSurvivor]);

      expect((await asAdmin(ws.b, () => preferences.list(ws.b, survivor))).map((e) => e.id).sort()).toEqual([activeOnMerged, onSurvivor].sort());
      // The merged customer stays unavailable, consistent with #3.
      await expect(asAdmin(ws.b, () => preferences.list(ws.b, merged))).rejects.toMatchObject({ code: 'NOT_FOUND', details: { mergedIntoId: survivor } });
      await expect(asAdmin(ws.b, () => preferences.create(ws.b, merged, { category: 'communication', content: 'x' }))).rejects.toMatchObject({ code: 'NOT_FOUND', details: { mergedIntoId: survivor } });
      await expect(asAdmin(ws.b, () => preferences.update(ws.b, merged, activeOnMerged, { content: 'x' }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('compliance erasure permanently purges the survivor\'s preferences (incl. re-associated ones) and all preference history', async () => {
      const ids = [onSurvivor, activeOnMerged, archivedOnMerged];
      const shopifyB = integrationIds[`${ws.b}:shopify`];
      const wooB = integrationIds[`${ws.b}:woocommerce`];

      await integrationService.purgeCommerceCustomer(ws.b, wooB, 'w1');
      const result = await integrationService.purgeCommerceCustomer(ws.b, shopifyB, 's1');

      expect(result).toEqual({ found: true, canonicalCustomerRemoved: true });
      expect(await db.client.select().from(customerPreferences).where(inArray(customerPreferences.id, ids))).toHaveLength(0);
      expect(await db.client.select().from(customerPreferenceHistory).where(inArray(customerPreferenceHistory.preferenceId, ids))).toHaveLength(0);
      expect(await db.client.select().from(customerPreferences).where(eq(customerPreferences.workspaceId, ws.b))).toHaveLength(0);
      // Workspace A's preferences are untouched by B's erasure.
      expect((await db.client.select().from(customerPreferences).where(eq(customerPreferences.workspaceId, ws.a))).length).toBeGreaterThan(0);
    });
  });
});
