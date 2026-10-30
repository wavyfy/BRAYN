import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
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
import { websiteSessions } from '../../database/schema/website-sessions';
import { websiteEvents } from '../../database/schema/website-events';
import { RequestContext } from '../../common/logging/request-context';
import { CustomerService, type NormalizedCustomer } from '../commerce/customer.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { IntegrationService } from './integration.service';
import type { IntegrationProvider } from './dto/connect-integration.schema';

/**
 * Customer erasure with linked website visitors against the real dev DB
 * (Phase 5 Blocker fix, Option C): a linked visitor and its sessions and
 * events (incl. the email-bearing `identity_signal`) are deleted with the
 * canonical customer — directly and through a merge survivor — while
 * unlinked visitors and other workspaces are untouched. Three throwaway
 * workspaces + one throwaway user, deleted in afterAll.
 */
// Every step is a real Neon round trip (~250ms each), so the default 5s per-test budget is too tight.
describe('Customer erasure — linked website visitors (real DB)', { timeout: 90_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let customers: CustomerService;
  let identity: IdentityResolutionService;
  let integrationService: IntegrationService;

  // a: direct erasure; b: another workspace that must stay untouched; c: merge then erasure.
  const ws = { a: randomUUID(), b: randomUUID(), c: randomUUID() };
  const integrationIds: Record<string, string> = {};
  let adminUserId = '';

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

  /** A visitor with one session, a page_view and (when linked) the identity_signal that carries the email. */
  async function seedVisitor(workspaceId: string, canonicalCustomerId: string | null, email: string | null) {
    const [visitor] = await db.client.insert(websiteVisitors).values({ workspaceId, visitorId: `v_${randomUUID()}`, canonicalCustomerId }).returning();
    const [session] = await db.client.insert(websiteSessions).values({ workspaceId, visitorId: visitor.id, sessionKey: `s_${randomUUID()}` }).returning();
    const occurredAt = new Date();
    await db.client.insert(websiteEvents).values([
      { workspaceId, visitorId: visitor.id, sessionId: session.id, eventId: randomUUID(), eventType: 'page_view', payload: { url: '/products/x' }, occurredAt },
      ...(email
        ? [{ workspaceId, visitorId: visitor.id, sessionId: session.id, eventId: randomUUID(), eventType: 'identity_signal' as const, payload: { email, verified: true }, occurredAt }]
        : []),
    ]);
    return visitor.id;
  }
  const websiteRowsOf = async (visitorId: string) => ({
    visitors: (await db.client.select().from(websiteVisitors).where(eq(websiteVisitors.id, visitorId))).length,
    sessions: (await db.client.select().from(websiteSessions).where(eq(websiteSessions.visitorId, visitorId))).length,
    events: (await db.client.select().from(websiteEvents).where(eq(websiteEvents.visitorId, visitorId))).length,
  });
  const canonicalExists = async (id: string) => (await db.client.select().from(canonicalCustomers).where(eq(canonicalCustomers.id, id))).length === 1;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    customers = moduleRef.get(CustomerService);
    identity = moduleRef.get(IdentityResolutionService);
    integrationService = moduleRef.get(IntegrationService);

    for (const workspaceId of [ws.a, ws.b, ws.c]) {
      await db.client.insert(workspaces).values({ id: workspaceId, name: 'Customer Erasure Website Test Workspace' });
      for (const provider of ['shopify', 'woocommerce'] as const) {
        const [integration] = await db.client.insert(integrations).values({ workspaceId, provider }).returning({ id: integrations.id });
        integrationIds[`${workspaceId}:${provider}`] = integration.id;
      }
    }
    [{ id: adminUserId }] = await db.client.insert(users).values({ clerkUserId: `test_erasure_web_${randomUUID()}` }).returning({ id: users.id });
  }, 90_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [ws.a, ws.b, ws.c];
    await db.client.delete(websiteEvents).where(inArray(websiteEvents.workspaceId, ids));
    await db.client.delete(websiteSessions).where(inArray(websiteSessions.workspaceId, ids));
    await db.client.delete(websiteVisitors).where(inArray(websiteVisitors.workspaceId, ids));
    await db.client.delete(identityMergeHistory).where(inArray(identityMergeHistory.workspaceId, ids));
    await db.client.delete(canonicalCustomerDuplicates).where(inArray(canonicalCustomerDuplicates.workspaceId, ids));
    await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
    await db.client.update(canonicalCustomers).set({ mergedIntoId: null }).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
    await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    if (adminUserId) await db.client.delete(users).where(eq(users.id, adminUserId));
    await moduleRef?.close();
  }, 60_000);

  it('customers/redact erases a customer with a linked visitor (session, page_view, identity_signal); unlinked visitors and other workspaces are untouched', async () => {
    await sync(ws.a, 'shopify', [customer('a1', 'ada@example.com')]);
    await sync(ws.b, 'shopify', [customer('b1', 'ada@example.com')]);
    const customerA = await linkOf(ws.a, 'shopify', 'a1');
    const customerB = await linkOf(ws.b, 'shopify', 'b1');

    const linkedA = await seedVisitor(ws.a, customerA, 'ada@example.com');
    const anonymousA = await seedVisitor(ws.a, null, null);
    const linkedB = await seedVisitor(ws.b, customerB, 'ada@example.com');
    expect(await websiteRowsOf(linkedA)).toEqual({ visitors: 1, sessions: 1, events: 2 });

    const result = await integrationService.purgeCommerceCustomer(ws.a, integrationIds[`${ws.a}:shopify`], 'a1');

    expect(result).toEqual({ found: true, canonicalCustomerRemoved: true });
    expect(await canonicalExists(customerA)).toBe(false);
    expect(await websiteRowsOf(linkedA)).toEqual({ visitors: 0, sessions: 0, events: 0 });
    // No identity_signal (email) left behind anywhere in the workspace.
    expect(await db.client.select().from(websiteEvents).where(and(eq(websiteEvents.workspaceId, ws.a), eq(websiteEvents.eventType, 'identity_signal')))).toHaveLength(0);
    // Unlinked (anonymous) visitor in the same workspace is untouched.
    expect(await websiteRowsOf(anonymousA)).toEqual({ visitors: 1, sessions: 1, events: 1 });
    // Same email, other workspace: customer and its linked visitor are untouched.
    expect(await canonicalExists(customerB)).toBe(true);
    expect(await websiteRowsOf(linkedB)).toEqual({ visitors: 1, sessions: 1, events: 2 });
    expect((await db.client.select().from(websiteVisitors).where(eq(websiteVisitors.id, linkedB)))[0].canonicalCustomerId).toBe(customerB);
  });

  it("erases a merged customer's visitor through the survivor", async () => {
    // Survivor (older, Shopify) and merged (newer, WooCommerce) share a phone.
    await sync(ws.c, 'shopify', [customer('s1', 'sam@example.com', '+14155550188')]);
    await sync(ws.c, 'woocommerce', [customer('w1', 'sammy@example.com', '+1 415 555 0188')]);
    const survivor = await linkOf(ws.c, 'shopify', 's1');
    const merged = await linkOf(ws.c, 'woocommerce', 'w1');
    const [pair] = await db.client
      .select()
      .from(canonicalCustomerDuplicates)
      .where(and(eq(canonicalCustomerDuplicates.workspaceId, ws.c), eq(canonicalCustomerDuplicates.matchedSignal, 'phone')));

    const mergedVisitor = await seedVisitor(ws.c, merged, 'sammy@example.com');
    const survivorVisitor = await seedVisitor(ws.c, survivor, 'sam@example.com');
    const anonymousC = await seedVisitor(ws.c, null, null);

    await RequestContext.run({ correlationId: randomUUID(), workspaceId: ws.c, actorUserId: adminUserId, actorRole: 'admin' }, () => identity.merge(ws.c, pair.id));
    // The merge moved the merged customer's visitor onto the survivor — the case that used to make erasure fail.
    expect((await db.client.select().from(websiteVisitors).where(eq(websiteVisitors.id, mergedVisitor)))[0].canonicalCustomerId).toBe(survivor);

    await integrationService.purgeCommerceCustomer(ws.c, integrationIds[`${ws.c}:woocommerce`], 'w1');
    const result = await integrationService.purgeCommerceCustomer(ws.c, integrationIds[`${ws.c}:shopify`], 's1');

    expect(result).toEqual({ found: true, canonicalCustomerRemoved: true });
    expect(await canonicalExists(survivor)).toBe(false);
    expect(await canonicalExists(merged)).toBe(false);
    expect(await websiteRowsOf(mergedVisitor)).toEqual({ visitors: 0, sessions: 0, events: 0 });
    expect(await websiteRowsOf(survivorVisitor)).toEqual({ visitors: 0, sessions: 0, events: 0 });
    expect(await websiteRowsOf(anonymousC)).toEqual({ visitors: 1, sessions: 1, events: 1 });
  });
});
