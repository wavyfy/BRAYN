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
import { websiteVisitors } from '../../database/schema/website-visitors';
import { RequestContext } from '../../common/logging/request-context';
import { CustomerService, type NormalizedCustomer } from '../commerce/customer.service';
import { IdentityResolutionService } from './identity-resolution.service';

/**
 * Identity review against the real dev DB: confidence on review records,
 * conflict recording (source email change, verified website email) that
 * never re-links, and owner/admin dismissal that is tenant-scoped and is
 * never re-created by later detection. Two throwaway workspaces + one
 * throwaway user, deleted in afterAll.
 */
// Every step is a real Neon round trip (~250ms each), so the default 5s per-test budget is too tight.
describe('Identity review — conflicts and dismissal (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let customers: CustomerService;
  let identity: IdentityResolutionService;

  const ws = { a: randomUUID(), b: randomUUID() };
  let integrationA = '';
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
  async function sync(batch: NormalizedCustomer[]) {
    await customers.upsertMany(ws.a, integrationA, 'shopify', batch);
    await identity.resolveMany(
      ws.a,
      'shopify',
      batch.map((c) => c.externalId),
    );
  }
  const linkOf = async (externalId: string) =>
    (await db.client.select().from(commerceCustomers).where(and(eq(commerceCustomers.workspaceId, ws.a), eq(commerceCustomers.externalId, externalId))))[0]
      .canonicalCustomerId as string;
  const review = (workspaceId: string) => db.client.select().from(canonicalCustomerDuplicates).where(eq(canonicalCustomerDuplicates.workspaceId, workspaceId));
  const asAdmin = <T>(workspaceId: string, fn: () => Promise<T>) =>
    RequestContext.run({ correlationId: randomUUID(), workspaceId, actorUserId: adminUserId, actorRole: 'admin' }, fn);

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
      await db.client.insert(workspaces).values({ id: workspaceId, name: 'Identity Review Test Workspace' });
    }
    [{ id: integrationA }] = await db.client.insert(integrations).values({ workspaceId: ws.a, provider: 'shopify' }).returning({ id: integrations.id });
    [{ id: adminUserId }] = await db.client.insert(users).values({ clerkUserId: `test_identity_review_${randomUUID()}` }).returning({ id: users.id });
  }, 60_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [ws.a, ws.b];
    await db.client.delete(canonicalCustomerDuplicates).where(inArray(canonicalCustomerDuplicates.workspaceId, ids));
    await db.client.delete(websiteVisitors).where(inArray(websiteVisitors.workspaceId, ids));
    await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
    await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
    await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    if (adminUserId) await db.client.delete(users).where(eq(users.id, adminUserId));
    await moduleRef?.close();
  }, 60_000);

  it('stores medium confidence on a phone duplicate', async () => {
    await sync([customer('p1', 'p1@example.com', '+14155550101'), customer('p2', 'p2@example.com', '+1 415 555 0101')]);

    const [phone] = (await review(ws.a)).filter((r) => r.matchedSignal === 'phone');
    expect(phone).toMatchObject({ confidence: 'medium', matchedValue: '+14155550101', status: 'pending', reviewedByUserId: null });
  });

  it('records a high-confidence email_conflict when a linked customer’s email changes to another customer’s, and never re-links', async () => {
    await sync([customer('e1', 'alice@example.com'), customer('e2', 'bob@example.com')]);
    const alice = await linkOf('e1');
    const bob = await linkOf('e2');

    await sync([customer('e1', 'Bob@Example.com')]);
    await sync([customer('e1', 'Bob@Example.com')]); // repeat: idempotent

    expect(await linkOf('e1')).toBe(alice);
    const conflicts = (await review(ws.a)).filter((r) => r.matchedSignal === 'email_conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ confidence: 'high', matchedValue: 'bob@example.com' });
    expect([conflicts[0].canonicalCustomerAId, conflicts[0].canonicalCustomerBId].sort()).toEqual([alice, bob].sort());
  });

  it('records a website_email_conflict when a linked visitor’s verified email belongs to another customer, keeping its link', async () => {
    const carol = (await db.client.insert(canonicalCustomers).values({ workspaceId: ws.a, primaryEmail: 'carol@example.com' }).returning())[0].id;
    const dave = (await db.client.insert(canonicalCustomers).values({ workspaceId: ws.a, primaryEmail: 'dave@example.com' }).returning())[0].id;
    const [visitor] = await db.client.insert(websiteVisitors).values({ workspaceId: ws.a, visitorId: `v-${randomUUID()}`, canonicalCustomerId: carol }).returning();

    await identity.resolveWebsiteVisitor(ws.a, visitor.id, 'dave@example.com');

    const [after] = await db.client.select().from(websiteVisitors).where(eq(websiteVisitors.id, visitor.id));
    expect(after.canonicalCustomerId).toBe(carol);
    const [conflict] = (await review(ws.a)).filter((r) => r.matchedSignal === 'website_email_conflict');
    expect(conflict).toMatchObject({ confidence: 'high', matchedValue: 'dave@example.com' });
    expect([conflict.canonicalCustomerAId, conflict.canonicalCustomerBId].sort()).toEqual([carol, dave].sort());
  });

  it('dismisses a candidate with who/when, keeps its detection data, and detection never re-creates it', async () => {
    const [phone] = (await review(ws.a)).filter((r) => r.matchedSignal === 'phone');

    const dismissed = await asAdmin(ws.a, () => identity.dismiss(ws.a, phone.id));

    expect(dismissed).toMatchObject({ status: 'dismissed', reviewedByUserId: adminUserId, confidence: 'medium', matchedValue: '+14155550101' });
    expect(dismissed.reviewedAt).toBeInstanceOf(Date);

    await sync([customer('p1', 'p1@example.com', '+14155550101'), customer('p2', 'p2@example.com', '+14155550101')]);
    const phoneRows = (await review(ws.a)).filter((r) => r.matchedSignal === 'phone');
    expect(phoneRows).toHaveLength(1);
    expect(phoneRows[0].status).toBe('dismissed');
    expect((await identity.listDuplicates(ws.a)).some((r) => r.id === phone.id)).toBe(false);

    await expect(asAdmin(ws.a, () => identity.dismiss(ws.a, phone.id))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('cannot dismiss another workspace’s candidate', async () => {
    const [conflict] = (await review(ws.a)).filter((r) => r.matchedSignal === 'email_conflict');

    await expect(asAdmin(ws.b, () => identity.dismiss(ws.b, conflict.id))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const [unchanged] = (await review(ws.a)).filter((r) => r.id === conflict.id);
    expect(unchanged.status).toBe('pending');
  });
});
