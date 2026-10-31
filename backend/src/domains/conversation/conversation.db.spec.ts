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
import { conversations } from '../../database/schema/conversations';
import { conversationMessages } from '../../database/schema/conversation-messages';
import { RequestContext } from '../../common/logging/request-context';
import { CustomerService, type NormalizedCustomer } from '../commerce/customer.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { ConversationService } from './conversation.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

/**
 * Slice 4.6 regression against the real dev DB and real Nest wiring:
 * conversations resolve the customer through the UCIR, so a merged
 * customer is refused (404 + mergedIntoId) instead of getting a new
 * conversation the survivor would never see. Two throwaway workspaces +
 * one throwaway user, deleted in afterAll.
 */
// Every step is a real Neon round trip (~250ms each), so the default 5s per-test budget is too tight.
describe('Conversations resolve customers through the UCIR (real DB)', { timeout: 90_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let customers: CustomerService;
  let identity: IdentityResolutionService;
  let service: ConversationService;

  const ws = { a: randomUUID(), b: randomUUID() };
  const integrationIds: Record<string, string> = {};
  let adminUserId = '';

  const customer = (externalId: string, email: string, phone: string): NormalizedCustomer => ({
    externalId,
    email,
    firstName: 'Sam',
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
  const asAdmin = <T>(workspaceId: string, fn: () => Promise<T>) =>
    RequestContext.run({ correlationId: randomUUID(), workspaceId, actorUserId: adminUserId, actorRole: 'admin' }, fn);
  const rowsFor = (workspaceId: string) => db.client.select().from(conversations).where(eq(conversations.workspaceId, workspaceId));

  let survivor = '';
  let merged = '';

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    customers = moduleRef.get(CustomerService);
    identity = moduleRef.get(IdentityResolutionService);
    service = moduleRef.get(ConversationService);

    for (const workspaceId of [ws.a, ws.b]) {
      await db.client.insert(workspaces).values({ id: workspaceId, name: 'Conversation UCIR Test Workspace' });
      for (const provider of ['shopify', 'woocommerce'] as const) {
        const [integration] = await db.client.insert(integrations).values({ workspaceId, provider }).returning({ id: integrations.id });
        integrationIds[`${workspaceId}:${provider}`] = integration.id;
      }
    }
    [{ id: adminUserId }] = await db.client.insert(users).values({ clerkUserId: `test_conversation_${randomUUID()}` }).returning({ id: users.id });
    // Same phone across providers → a phone duplicate pair that can be merged.
    await sync(ws.a, 'shopify', [customer('s1', 'sam@example.com', '+14155550177')]);
    await sync(ws.a, 'woocommerce', [customer('w1', 'sammy@example.com', '+1 415 555 0177')]);
    survivor = await linkOf(ws.a, 'shopify', 's1');
    merged = await linkOf(ws.a, 'woocommerce', 'w1');
  }, 90_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [ws.a, ws.b];
    await db.client.delete(conversationMessages).where(inArray(conversationMessages.workspaceId, ids));
    await db.client.delete(conversations).where(inArray(conversations.workspaceId, ids));
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

  it('starts and lists conversations for an active customer', async () => {
    const started = await service.startConversation(ws.a, merged, { channel: 'whatsapp' });

    expect(started).toMatchObject({ workspaceId: ws.a, canonicalCustomerId: merged, status: 'open' });
    expect((await service.listConversations(ws.a, merged)).map((c) => c.id)).toEqual([started.id]);
  });

  it('refuses a customer from another workspace or an unknown id, and creates nothing', async () => {
    await expect(service.startConversation(ws.b, survivor, { channel: 'whatsapp' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.listConversations(ws.b, survivor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.startConversation(ws.a, randomUUID(), { channel: 'whatsapp' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await rowsFor(ws.b)).toHaveLength(0);
  });

  it('after a merge, refuses the merged customer (404 + mergedIntoId) and the survivor carries the conversation', async () => {
    const [before] = await rowsFor(ws.a);
    const [pair] = await db.client
      .select()
      .from(canonicalCustomerDuplicates)
      .where(and(eq(canonicalCustomerDuplicates.workspaceId, ws.a), eq(canonicalCustomerDuplicates.matchedSignal, 'phone')));
    await asAdmin(ws.a, () => identity.merge(ws.a, pair.id));

    await expect(service.startConversation(ws.a, merged, { channel: 'whatsapp' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { mergedIntoId: survivor },
    });
    await expect(service.listConversations(ws.a, merged)).rejects.toMatchObject({ code: 'NOT_FOUND', details: { mergedIntoId: survivor } });

    // No conversation was created on the merged customer; the moved one is reused for the survivor.
    const rows = await rowsFor(ws.a);
    expect(rows.map((row) => [row.id, row.canonicalCustomerId])).toEqual([[before.id, survivor]]);
    expect((await service.startConversation(ws.a, survivor, { channel: 'whatsapp' })).id).toBe(before.id);
    expect((await service.listConversations(ws.a, survivor)).map((c) => c.id)).toEqual([before.id]);
  });
});
