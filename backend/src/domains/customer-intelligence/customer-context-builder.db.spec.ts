import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { customerMemoryEntries } from '../../database/schema/customer-memory-entries';
import { customerMemoryEntryHistory } from '../../database/schema/customer-memory-entry-history';
import { customerPreferenceHistory, customerPreferences } from '../../database/schema/customer-preferences';
import { protectedDataAccessLog } from '../../database/schema/protected-data-access-log';
import { RequestContext } from '../../common/logging/request-context';
import { AiGatewayService } from '../ai/ai-gateway.service';
import type { AiMessage } from '../ai/ai-provider.interface';
import { MerchantBusinessAnalystService } from '../ai-agents/merchant-business-analyst.service';
import { CustomerService, type NormalizedCustomer } from '../commerce/customer.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { IntegrationService } from '../integration/integration.service';
import { CustomerMemoryService } from './customer-memory.service';
import { CustomerPreferenceService } from './customer-preference.service';
import { CustomerContextBuilder } from './customer-context-builder.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

/**
 * Slice 4.3 Context Builder against the real dev DB and the real Nest
 * wiring (only the AI Gateway is stubbed, to capture what the model would
 * be sent): active-only notes, tenant isolation, owner/admin gate in the
 * Merchant Business Analyst, merged customers, and erasure — nothing
 * erased can reach the model. Two throwaway workspaces + one throwaway
 * user, deleted in afterAll.
 */
// Every step is a real Neon round trip (~250ms each), so the default 5s per-test budget is too tight.
describe('Customer Context Builder (real DB)', { timeout: 90_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let customers: CustomerService;
  let identity: IdentityResolutionService;
  let integrationService: IntegrationService;
  let memory: CustomerMemoryService;
  let preferences: CustomerPreferenceService;
  let builder: CustomerContextBuilder;
  let analyst: MerchantBusinessAnalystService;
  const generate = vi.fn<(request: { messages: AiMessage[] }) => Promise<{ content: string; model: string; provider: string }>>(async () => ({ content: 'answer', model: 'stub', provider: 'stub' }));

  const ws = { a: randomUUID(), b: randomUUID() };
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
  const as = <T>(workspaceId: string, actorRole: string, fn: () => Promise<T>) =>
    RequestContext.run({ correlationId: randomUUID(), workspaceId, actorUserId: adminUserId, actorRole } as never, fn);
  const sentToModel = () => JSON.stringify(generate.mock.calls.at(-1)?.[0].messages ?? []);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AiGatewayService)
      .useValue({ generate })
      .compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    customers = moduleRef.get(CustomerService);
    identity = moduleRef.get(IdentityResolutionService);
    integrationService = moduleRef.get(IntegrationService);
    memory = moduleRef.get(CustomerMemoryService);
    preferences = moduleRef.get(CustomerPreferenceService);
    builder = moduleRef.get(CustomerContextBuilder);
    analyst = moduleRef.get(MerchantBusinessAnalystService);

    for (const workspaceId of [ws.a, ws.b]) {
      await db.client.insert(workspaces).values({ id: workspaceId, name: 'Customer Context Builder Test Workspace' });
      for (const provider of ['shopify', 'woocommerce'] as const) {
        const [integration] = await db.client.insert(integrations).values({ workspaceId, provider }).returning({ id: integrations.id });
        integrationIds[`${workspaceId}:${provider}`] = integration.id;
      }
    }
    [{ id: adminUserId }] = await db.client.insert(users).values({ clerkUserId: `test_context_${randomUUID()}` }).returning({ id: users.id });
  }, 90_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [ws.a, ws.b];
    await db.client.delete(protectedDataAccessLog).where(inArray(protectedDataAccessLog.workspaceId, ids));
    await db.client.delete(customerPreferenceHistory).where(inArray(customerPreferenceHistory.workspaceId, ids));
    await db.client.delete(customerPreferences).where(inArray(customerPreferences.workspaceId, ids));
    await db.client.delete(customerMemoryEntryHistory).where(inArray(customerMemoryEntryHistory.workspaceId, ids));
    await db.client.delete(customerMemoryEntries).where(inArray(customerMemoryEntries.workspaceId, ids));
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

  it('builds from active notes only, preferences first; archived ones never appear; another workspace gets a 404', async () => {
    await sync(ws.a, 'shopify', [customer('a1', 'ada@example.com')]);
    const customerA = await linkOf(ws.a, 'shopify', 'a1');
    await as(ws.a, 'admin', async () => {
      await preferences.create(ws.a, customerA, { category: 'communication', content: 'Prefers email over SMS' });
      await memory.create(ws.a, customerA, { content: 'Weekend delivery only' });
      const archived = await memory.create(ws.a, customerA, { content: 'ARCHIVED-NOTE should never reach AI' });
      await memory.archive(ws.a, customerA, archived.id);
      const archivedPref = await preferences.create(ws.a, customerA, { category: 'product', content: 'ARCHIVED-PREF never reaches AI' });
      await preferences.archive(ws.a, customerA, archivedPref.id);
    });

    const context = await builder.build(ws.a, customerA, 'weekend delivery?');

    expect(context).toMatchObject({ preferences: 1, memories: 1, omitted: 0 });
    expect(context.block).toContain('- [communication] Prefers email over SMS');
    expect(context.block).toContain('- Weekend delivery only');
    expect(context.block).not.toContain('ARCHIVED');
    expect(context.block!.indexOf('Preferences:')).toBeLessThan(context.block!.indexOf('Memory:'));
    await expect(builder.build(ws.b, customerA, 'q')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a customer with no notes gives an empty context and the analyst sends no notes block', async () => {
    await sync(ws.a, 'shopify', [customer('a2', 'bob@example.com')]);
    const customerB = await linkOf(ws.a, 'shopify', 'a2');

    expect(await builder.build(ws.a, customerB, 'q')).toEqual({ block: null, preferences: 0, memories: 0, omitted: 0 });
    await as(ws.a, 'owner', () => analyst.ask(ws.a, 'Anything to know?', customerB));
    expect(sentToModel()).not.toContain('Merchant notes');
  });

  it('the analyst sends notes for owner/admin only, labelled as unverified and separate from verified facts', async () => {
    const customerA = await linkOf(ws.a, 'shopify', 'a1');

    await as(ws.a, 'admin', () => analyst.ask(ws.a, 'How should we contact them?', customerA));
    const messages = generate.mock.calls.at(-1)![0].messages;
    const notes = messages.find((m) => m.content.startsWith('CATEGORY: Merchant notes'));
    expect(notes?.content).toContain('Prefers email over SMS');
    expect(notes?.content).toContain('NOT verified customer facts');
    expect(messages.find((m) => m.content.includes('Verified customer facts'))?.content).not.toContain('Prefers email');

    for (const role of ['marketing', 'support', 'analyst']) {
      await as(ws.a, role, () => analyst.ask(ws.a, 'How should we contact them?', customerA));
      expect(sentToModel()).not.toContain('Prefers email over SMS');
      expect(sentToModel()).not.toContain('Merchant notes');
    }
  });

  it('after an identity merge the survivor carries both sides\' notes and the merged id is a 404', async () => {
    await sync(ws.b, 'shopify', [customer('s1', 'sam@example.com', '+14155550177')]);
    await sync(ws.b, 'woocommerce', [customer('w1', 'sammy@example.com', '+1 415 555 0177')]);
    const survivor = await linkOf(ws.b, 'shopify', 's1');
    const merged = await linkOf(ws.b, 'woocommerce', 'w1');
    await as(ws.b, 'admin', async () => {
      await memory.create(ws.b, survivor, { content: 'Survivor side note' });
      await preferences.create(ws.b, merged, { category: 'interaction', content: 'Merged side: wants a call first' });
    });
    const [pair] = await db.client
      .select()
      .from(canonicalCustomerDuplicates)
      .where(and(eq(canonicalCustomerDuplicates.workspaceId, ws.b), eq(canonicalCustomerDuplicates.matchedSignal, 'phone')));
    await as(ws.b, 'admin', () => identity.merge(ws.b, pair.id));

    const context = await builder.build(ws.b, survivor, 'call');
    expect(context.block).toContain('Merged side: wants a call first');
    expect(context.block).toContain('Survivor side note');
    await expect(builder.build(ws.b, merged, 'q')).rejects.toMatchObject({ code: 'NOT_FOUND', details: { mergedIntoId: survivor } });
  });

  it('after compliance erasure nothing about the customer can reach the model', async () => {
    const survivor = await linkOf(ws.b, 'shopify', 's1');
    await integrationService.purgeCommerceCustomer(ws.b, integrationIds[`${ws.b}:woocommerce`], 'w1');
    await integrationService.purgeCommerceCustomer(ws.b, integrationIds[`${ws.b}:shopify`], 's1');

    await expect(builder.build(ws.b, survivor, 'q')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    generate.mockClear();
    await expect(as(ws.b, 'owner', () => analyst.ask(ws.b, 'call?', survivor))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(generate).not.toHaveBeenCalled();
    expect(await db.client.select().from(customerPreferences).where(eq(customerPreferences.workspaceId, ws.b))).toHaveLength(0);
    expect(await db.client.select().from(customerMemoryEntries).where(eq(customerMemoryEntries.workspaceId, ws.b))).toHaveLength(0);
  });
});
