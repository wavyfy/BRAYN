import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray, or } from 'drizzle-orm';
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
import { websiteVisitors } from '../../database/schema/website-visitors';
import { conversations } from '../../database/schema/conversations';
import { customerHealthStates } from '../../database/schema/customer-health-states';
import { customerHealthStateHistory } from '../../database/schema/customer-health-state-history';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { RequestContext } from '../../common/logging/request-context';
import { EventBus } from '../../common/events/event-bus.service';
import { CustomerService, type NormalizedCustomer } from '../commerce/customer.service';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { IntegrationService } from '../integration/integration.service';
import { IdentityResolutionService } from './identity-resolution.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

/**
 * Manual safe merge against the real dev DB (row locks, one transaction,
 * FK-backed rollback): the full approved merge effect set, resolution
 * following the merge afterwards, UCIR hiding the merged customer, tenant
 * isolation, all-or-nothing rollback, and compliance erasure still working
 * across a merge. Two throwaway workspaces + one throwaway user, deleted in
 * afterAll.
 */
// Every step is a real Neon round trip (~250ms each), so the default 5s per-test budget is too tight.
describe('Identity safe merge (real DB)', { timeout: 90_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let customers: CustomerService;
  let identity: IdentityResolutionService;
  let intelligence: CustomerIntelligenceService;
  let integrationService: IntegrationService;
  let eventBus: EventBus;

  const ws = { a: randomUUID(), b: randomUUID() };
  const integrationIds: Record<string, string> = {};
  let adminUserId = '';

  // Workspace A fixture ids, filled in beforeAll.
  let survivor = '';
  let merged = '';
  let third = '';
  let phoneCandidate = '';
  let otherCandidate = '';
  let mergedVisitor = '';
  let unlinkedVisitor = '';
  let openOpportunity = '';
  let closedOpportunity = '';
  let activeRecommendation = '';
  let conversation = '';

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
    )[0]?.canonicalCustomerId;
  const canonical = async (id: string) => (await db.client.select().from(canonicalCustomers).where(eq(canonicalCustomers.id, id)))[0];
  const candidate = async (id: string) => (await db.client.select().from(canonicalCustomerDuplicates).where(eq(canonicalCustomerDuplicates.id, id)))[0];
  const asAdmin = <T>(workspaceId: string, fn: () => Promise<T>) =>
    RequestContext.run({ correlationId: randomUUID(), workspaceId, actorUserId: adminUserId, actorRole: 'admin' }, fn);
  const phonePairIn = async (workspaceId: string) =>
    (
      await db.client
        .select()
        .from(canonicalCustomerDuplicates)
        .where(and(eq(canonicalCustomerDuplicates.workspaceId, workspaceId), eq(canonicalCustomerDuplicates.matchedSignal, 'phone')))
    )[0];

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
    integrationService = moduleRef.get(IntegrationService);
    eventBus = moduleRef.get(EventBus);

    for (const workspaceId of [ws.a, ws.b]) {
      await db.client.insert(workspaces).values({ id: workspaceId, name: 'Identity Merge Test Workspace' });
      for (const provider of ['shopify', 'woocommerce'] as const) {
        const [integration] = await db.client.insert(integrations).values({ workspaceId, provider }).returning({ id: integrations.id });
        integrationIds[`${workspaceId}:${provider}`] = integration.id;
      }
    }
    [{ id: adminUserId }] = await db.client.insert(users).values({ clerkUserId: `test_identity_merge_${randomUUID()}` }).returning({ id: users.id });

    // Workspace A: survivor (older, Shopify) and merged (newer, WooCommerce) share a phone.
    await sync(ws.a, 'shopify', [customer('s1', 'sam@example.com', '+14155550199')]);
    await sync(ws.a, 'woocommerce', [customer('w1', 'sammy@example.com', '+1 415 555 0199')]);
    survivor = (await linkOf(ws.a, 'shopify', 's1')) as string;
    merged = (await linkOf(ws.a, 'woocommerce', 'w1')) as string;
    phoneCandidate = (await phonePairIn(ws.a)).id;

    // A third customer with its own pending candidate against the merged one.
    [{ id: third }] = await db.client.insert(canonicalCustomers).values({ workspaceId: ws.a, primaryEmail: 'third@example.com' }).returning();
    const [a, b] = [merged, third].sort();
    [{ id: otherCandidate }] = await db.client
      .insert(canonicalCustomerDuplicates)
      .values({ workspaceId: ws.a, canonicalCustomerAId: a, canonicalCustomerBId: b, matchedSignal: 'email_conflict', confidence: 'high', matchedValue: 'third@example.com' })
      .returning();

    // Data hanging off the merged customer.
    [{ id: mergedVisitor }] = await db.client.insert(websiteVisitors).values({ workspaceId: ws.a, visitorId: `v-${randomUUID()}`, canonicalCustomerId: merged }).returning();
    [{ id: unlinkedVisitor }] = await db.client.insert(websiteVisitors).values({ workspaceId: ws.a, visitorId: `v-${randomUUID()}` }).returning();
    [{ id: conversation }] = await db.client.insert(conversations).values({ workspaceId: ws.a, canonicalCustomerId: merged, channel: 'whatsapp' }).returning();
    const health = { workspaceId: ws.a, canonicalCustomerId: merged, signals: { probe: true }, reasonCodes: ['probe'], lastCalculatedAt: new Date() };
    await db.client.insert(customerHealthStates).values(health);
    await db.client.insert(customerHealthStateHistory).values({ ...health, calculatedAt: health.lastCalculatedAt });
    const opportunity = { workspaceId: ws.a, canonicalCustomerId: merged, type: 'reorder' as const, priority: 'medium' as const, confidence: 70, reason: 'r', recommendedAction: 'a' };
    [{ id: openOpportunity }] = await db.client.insert(revenueOpportunities).values(opportunity).returning();
    [{ id: closedOpportunity }] = await db.client.insert(revenueOpportunities).values({ ...opportunity, type: 'win_back', status: 'converted' }).returning();
    [{ id: activeRecommendation }] = await db.client
      .insert(recommendations)
      .values({ workspaceId: ws.a, canonicalCustomerId: merged, sourceOpportunityId: openOpportunity, text: 't', supportingSignals: {} })
      .returning();

    // Workspace B: a separate pair used for the rollback and erasure checks.
    await sync(ws.b, 'shopify', [customer('b1', 'bea@example.com', '+442079460101'), customer('b2', 'b.e.a@example.com', '+44 20 7946 0101')]);
  }, 90_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [ws.a, ws.b];
    await db.client.delete(identityMergeHistory).where(inArray(identityMergeHistory.workspaceId, ids));
    await db.client.delete(canonicalCustomerDuplicates).where(inArray(canonicalCustomerDuplicates.workspaceId, ids));
    await db.client.delete(recommendations).where(inArray(recommendations.workspaceId, ids));
    await db.client.delete(revenueOpportunities).where(inArray(revenueOpportunities.workspaceId, ids));
    await db.client.delete(customerHealthStateHistory).where(inArray(customerHealthStateHistory.workspaceId, ids));
    await db.client.delete(customerHealthStates).where(inArray(customerHealthStates.workspaceId, ids));
    await db.client.delete(conversations).where(inArray(conversations.workspaceId, ids));
    await db.client.delete(websiteVisitors).where(inArray(websiteVisitors.workspaceId, ids));
    await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
    await db.client.update(canonicalCustomers).set({ mergedIntoId: null }).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
    await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    if (adminUserId) await db.client.delete(users).where(eq(users.id, adminUserId));
    await moduleRef?.close();
  }, 60_000);

  it('refuses a merge from another workspace (tenant isolation) and leaves everything untouched', async () => {
    await expect(asAdmin(ws.b, () => identity.merge(ws.b, phoneCandidate))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await candidate(phoneCandidate)).status).toBe('pending');
    expect((await canonical(merged)).mergedIntoId).toBeNull();
  });

  it('rolls the whole merge back when any step fails — nothing partial is committed', async () => {
    const pair = await phonePairIn(ws.b);
    const original = db.transaction.bind(db);
    // Fail the *last* write (marking the merged customer), after every other step has run.
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
      await expect(asAdmin(ws.b, () => identity.merge(ws.b, pair.id))).rejects.toThrow('injected failure');
    } finally {
      spy.mockRestore();
    }

    expect((await candidate(pair.id)).status).toBe('pending');
    expect(await db.client.select().from(identityMergeHistory).where(eq(identityMergeHistory.workspaceId, ws.b))).toHaveLength(0);
    const b1 = await linkOf(ws.b, 'shopify', 'b1');
    const b2 = await linkOf(ws.b, 'shopify', 'b2');
    expect(b1).not.toBe(b2);
    expect((await canonical(b1 as string)).mergedIntoId).toBeNull();
    expect((await canonical(b2 as string)).mergedIntoId).toBeNull();
  });

  it('merges into the older customer with the full approved effect set, without emitting events', async () => {
    const emit = vi.spyOn(eventBus, 'emit');

    const result = await asAdmin(ws.a, () => identity.merge(ws.a, phoneCandidate, '  Same shopper  '));

    expect(emit).not.toHaveBeenCalled();
    emit.mockRestore();
    expect(result).toMatchObject({ survivingCanonicalCustomerId: survivor, mergedCanonicalCustomerId: merged });

    // History: who/what/why + pre-merge snapshot of both sides.
    const [history] = await db.client.select().from(identityMergeHistory).where(eq(identityMergeHistory.id, result.mergeHistoryId));
    expect(history).toMatchObject({
      workspaceId: ws.a,
      survivingCanonicalCustomerId: survivor,
      mergedCanonicalCustomerId: merged,
      duplicateId: phoneCandidate,
      performedByUserId: adminUserId,
      matchedSignal: 'phone',
      confidence: 'medium',
      reason: 'Same shopper',
    });
    expect(history.snapshot.merged).toMatchObject({ canonicalCustomerId: merged, primaryEmail: 'sammy@example.com', websiteVisitorIds: [mergedVisitor] });
    expect(history.snapshot.merged.sourceRecords).toEqual([
      expect.objectContaining({ provider: 'woocommerce', externalId: 'w1', phone: '+1 415 555 0199', phoneE164: '+14155550199' }),
    ]);
    expect(history.snapshot.merged.healthState).toMatchObject({ reasonCodes: ['probe'] });
    expect(history.snapshot.surviving.sourceRecords).toEqual([expect.objectContaining({ provider: 'shopify', externalId: 's1' })]);

    // Identity links + conversations re-pointed; source identifiers preserved.
    expect(await linkOf(ws.a, 'woocommerce', 'w1')).toBe(survivor);
    const [visitor] = await db.client.select().from(websiteVisitors).where(eq(websiteVisitors.id, mergedVisitor));
    expect(visitor.canonicalCustomerId).toBe(survivor);
    const [conv] = await db.client.select().from(conversations).where(eq(conversations.id, conversation));
    expect(conv.canonicalCustomerId).toBe(survivor);

    // Health: merged current state removed, its history kept, survivor not recalculated.
    expect(await db.client.select().from(customerHealthStates).where(eq(customerHealthStates.canonicalCustomerId, merged))).toHaveLength(0);
    expect(await db.client.select().from(customerHealthStateHistory).where(eq(customerHealthStateHistory.canonicalCustomerId, merged))).toHaveLength(1);
    expect(await db.client.select().from(customerHealthStates).where(eq(customerHealthStates.canonicalCustomerId, survivor))).toHaveLength(0);

    // Derived records closed, not deleted; already-terminal ones untouched.
    const [open] = await db.client.select().from(revenueOpportunities).where(eq(revenueOpportunities.id, openOpportunity));
    expect(open).toMatchObject({ canonicalCustomerId: merged, status: 'expired', closedReason: 'customer_merged' });
    const [done] = await db.client.select().from(revenueOpportunities).where(eq(revenueOpportunities.id, closedOpportunity));
    expect(done).toMatchObject({ status: 'converted', closedReason: null });
    const [rec] = await db.client.select().from(recommendations).where(eq(recommendations.id, activeRecommendation));
    expect(rec).toMatchObject({ canonicalCustomerId: merged, state: 'dismissed', closedReason: 'customer_merged' });

    // Review records: this one merged, the other involving the merged customer superseded — detection data kept.
    expect(await candidate(phoneCandidate)).toMatchObject({ status: 'merged', reviewedByUserId: adminUserId, confidence: 'medium', matchedValue: '+14155550199' });
    expect(await candidate(otherCandidate)).toMatchObject({ status: 'superseded', matchedSignal: 'email_conflict', confidence: 'high' });

    // Merged customer kept (not deleted), marked into the survivor.
    const mergedRow = await canonical(merged);
    expect(mergedRow).toMatchObject({ mergedIntoId: survivor, primaryEmail: 'sammy@example.com' });
    expect(mergedRow.mergedAt).toBeInstanceOf(Date);
  });

  it('refuses to merge the same candidate twice, or a superseded one', async () => {
    await expect(asAdmin(ws.a, () => identity.merge(ws.a, phoneCandidate))).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(asAdmin(ws.a, () => identity.merge(ws.a, otherCandidate))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('never re-creates the merged customer: re-syncs, new source rows and visitor signals resolve to the survivor', async () => {
    const before = (await db.client.select().from(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, ws.a))).length;

    await sync(ws.a, 'woocommerce', [customer('w1', 'sammy@example.com', '+14155550199')]);
    await sync(ws.a, 'shopify', [customer('s2', 'Sammy@Example.com')]);
    await identity.resolveWebsiteVisitor(ws.a, unlinkedVisitor, 'sammy@example.com');

    expect(await linkOf(ws.a, 'woocommerce', 'w1')).toBe(survivor);
    expect(await linkOf(ws.a, 'shopify', 's2')).toBe(survivor);
    const [visitor] = await db.client.select().from(websiteVisitors).where(eq(websiteVisitors.id, unlinkedVisitor));
    expect(visitor.canonicalCustomerId).toBe(survivor);
    expect((await db.client.select().from(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, ws.a))).length).toBe(before);
    // The survivor's own source rows sharing a phone never pair it with itself.
    const selfPairs = await db.client
      .select()
      .from(canonicalCustomerDuplicates)
      .where(and(eq(canonicalCustomerDuplicates.canonicalCustomerAId, survivor), eq(canonicalCustomerDuplicates.canonicalCustomerBId, survivor)));
    expect(selfPairs).toHaveLength(0);
  });

  it('hides the merged customer from UCIR lists/search/counts and 404s its detail with mergedIntoId', async () => {
    const page = await intelligence.listCustomers(ws.a, { limit: 50 });
    expect(page.customers.map((c) => c.canonicalCustomerId)).not.toContain(merged);
    expect(page.customers.map((c) => c.canonicalCustomerId)).toContain(survivor);
    expect((await intelligence.listCustomers(ws.a, { search: 'sammy' })).customers).toHaveLength(0);
    expect((await intelligence.getWorkspaceSummary(ws.a)).customersCount).toBe(2); // survivor + third

    await expect(intelligence.getCustomer(ws.a, merged)).rejects.toMatchObject({ code: 'NOT_FOUND', details: { mergedIntoId: survivor } });
    const survivorRecord = await intelligence.getCustomer(ws.a, survivor);
    expect(survivorRecord.commerceContext).toBeDefined();
  });

  it('keeps compliance erasure working across a merge: erasing the survivor also erases the merged customer and its history', async () => {
    const pair = await phonePairIn(ws.b);
    const { survivingCanonicalCustomerId, mergedCanonicalCustomerId } = await asAdmin(ws.b, () => identity.merge(ws.b, pair.id));
    const shopifyB = integrationIds[`${ws.b}:shopify`];

    await integrationService.purgeCommerceCustomer(ws.b, shopifyB, 'b1');
    const result = await integrationService.purgeCommerceCustomer(ws.b, shopifyB, 'b2');

    expect(result).toEqual({ found: true, canonicalCustomerRemoved: true });
    const left = await db.client
      .select()
      .from(canonicalCustomers)
      .where(or(eq(canonicalCustomers.id, survivingCanonicalCustomerId), eq(canonicalCustomers.id, mergedCanonicalCustomerId)));
    expect(left).toHaveLength(0);
    expect(await db.client.select().from(identityMergeHistory).where(eq(identityMergeHistory.workspaceId, ws.b))).toHaveLength(0);
    expect(await db.client.select().from(canonicalCustomerDuplicates).where(eq(canonicalCustomerDuplicates.workspaceId, ws.b))).toHaveLength(0);
  });
});
