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
import { customerSummaries } from '../../database/schema/customer-summaries';
import { protectedDataAccessLog } from '../../database/schema/protected-data-access-log';
import { RequestContext } from '../../common/logging/request-context';
import { AiGatewayService } from '../ai/ai-gateway.service';
import type { AiMessage } from '../ai/ai-provider.interface';
import { MerchantBusinessAnalystService } from '../ai-agents/merchant-business-analyst.service';
import { CustomerService, type NormalizedCustomer } from '../commerce/customer.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { IntegrationService } from '../integration/integration.service';
import { CustomerMemoryService } from './customer-memory.service';
import { CustomerSummaryService } from './customer-summary.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

/**
 * Slice 4.5 persisted AI summary against the real dev DB and real Nest
 * wiring (only the AI Gateway is stubbed): one row per customer
 * overwritten on regeneration, stale flag when the input data changes,
 * never fed back into AI context, tenant isolation, merge (merged row
 * deleted, survivor stale) and erasure. Two throwaway workspaces + one
 * throwaway user, deleted in afterAll.
 */
// Every step is a real Neon round trip (~250ms each), so the default 5s per-test budget is too tight.
describe('Customer summary (real DB)', { timeout: 90_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let customers: CustomerService;
  let identity: IdentityResolutionService;
  let integrationService: IntegrationService;
  let memory: CustomerMemoryService;
  let summaries: CustomerSummaryService;
  let analyst: MerchantBusinessAnalystService;
  let reply = 'SUMMARY-ONE';
  const generate = vi.fn<(request: { messages: AiMessage[]; capability?: string }) => Promise<{ content: string; model: string; provider: string }>>(async () => ({
    content: reply,
    model: 'stub-model',
    provider: 'stub',
  }));

  const ws = { a: randomUUID(), b: randomUUID() };
  const integrationIds: Record<string, string> = {};
  let adminUserId = '';

  const customer = (externalId: string, email: string | null, phone: string | null = null): NormalizedCustomer => ({
    externalId,
    email,
    firstName: 'Ada',
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
  const rowsFor = (workspaceId: string) => db.client.select().from(customerSummaries).where(eq(customerSummaries.workspaceId, workspaceId));

  let customerA = '';

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
    summaries = moduleRef.get(CustomerSummaryService);
    analyst = moduleRef.get(MerchantBusinessAnalystService);

    for (const workspaceId of [ws.a, ws.b]) {
      await db.client.insert(workspaces).values({ id: workspaceId, name: 'Customer Summary Test Workspace' });
      for (const provider of ['shopify', 'woocommerce'] as const) {
        const [integration] = await db.client.insert(integrations).values({ workspaceId, provider }).returning({ id: integrations.id });
        integrationIds[`${workspaceId}:${provider}`] = integration.id;
      }
    }
    [{ id: adminUserId }] = await db.client.insert(users).values({ clerkUserId: `test_summary_${randomUUID()}` }).returning({ id: users.id });
    await sync(ws.a, 'shopify', [customer('a1', 'ada@example.com')]);
    customerA = await linkOf(ws.a, 'shopify', 'a1');
  }, 90_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [ws.a, ws.b];
    await db.client.delete(customerSummaries).where(inArray(customerSummaries.workspaceId, ids));
    await db.client.delete(protectedDataAccessLog).where(inArray(protectedDataAccessLog.workspaceId, ids));
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

  it('returns no summary before the first generation', async () => {
    expect(await summaries.get(ws.a, customerA)).toEqual({ summary: null, stale: false });
  });

  it('generates from UCIR data + merchant notes (no email/phone), stores it as ai_generated, and it is not stale', async () => {
    await asAdmin(ws.a, () => memory.create(ws.a, customerA, { content: 'Prefers weekend delivery' }));
    reply = '  SUMMARY-ONE  ';

    const view = await asAdmin(ws.a, () => summaries.generate(ws.a, customerA));

    expect(view).toMatchObject({ summary: { content: 'SUMMARY-ONE', provenance: 'ai_generated', model: 'stub-model', generatedByUserId: adminUserId }, stale: false });
    const request = generate.mock.calls.at(-1)![0];
    expect(request.capability).toBe('customer-summary');
    const input = request.messages.map((m) => m.content).join('\n');
    expect(input).toContain('Name: Ada');
    expect(input).toContain('Prefers weekend delivery');
    expect(input).not.toContain('ada@example.com');
    expect(await rowsFor(ws.a)).toHaveLength(1);
    expect(await summaries.get(ws.a, customerA)).toMatchObject({ summary: { content: 'SUMMARY-ONE' }, stale: false });
  });

  it('turns stale when the customer data changes, and regeneration overwrites the single row and clears it', async () => {
    await asAdmin(ws.a, () => memory.create(ws.a, customerA, { content: 'Allergic to wool' }));
    expect((await summaries.get(ws.a, customerA)).stale).toBe(true);

    reply = 'SUMMARY-TWO';
    const view = await asAdmin(ws.a, () => summaries.generate(ws.a, customerA));

    expect(view).toMatchObject({ summary: { content: 'SUMMARY-TWO' }, stale: false });
    expect(await rowsFor(ws.a)).toHaveLength(1);
    expect((await summaries.get(ws.a, customerA)).stale).toBe(false);
  });

  it('an empty AI reply is refused and keeps the previous summary', async () => {
    reply = '   ';
    await expect(asAdmin(ws.a, () => summaries.generate(ws.a, customerA))).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
    expect((await summaries.get(ws.a, customerA)).summary?.content).toBe('SUMMARY-TWO');
  });

  it('is never fed back into AI context', async () => {
    await asAdmin(ws.a, () => analyst.ask(ws.a, 'Tell me about this customer', customerA));
    expect(JSON.stringify(generate.mock.calls.at(-1)![0].messages)).not.toContain('SUMMARY-TWO');
  });

  it('isolates workspaces and refuses without an actor or for a bad id', async () => {
    await expect(summaries.get(ws.b, customerA)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(asAdmin(ws.b, () => summaries.generate(ws.b, customerA))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(summaries.get(ws.a, 'not-a-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(summaries.generate(ws.a, customerA)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await rowsFor(ws.b)).toHaveLength(0);
  });

  it("merge deletes the merged customer's summary and the survivor's turns stale; erasure deletes the rest", async () => {
    await sync(ws.b, 'shopify', [customer('s1', 'sam@example.com', '+14155550166')]);
    await sync(ws.b, 'woocommerce', [customer('w1', 'sammy@example.com', '+1 415 555 0166')]);
    const survivor = await linkOf(ws.b, 'shopify', 's1');
    const merged = await linkOf(ws.b, 'woocommerce', 'w1');
    reply = 'SURVIVOR-SUMMARY';
    await asAdmin(ws.b, () => summaries.generate(ws.b, survivor));
    reply = 'MERGED-SUMMARY';
    await asAdmin(ws.b, () => summaries.generate(ws.b, merged));
    expect((await summaries.get(ws.b, survivor)).stale).toBe(false);

    const [pair] = await db.client
      .select()
      .from(canonicalCustomerDuplicates)
      .where(and(eq(canonicalCustomerDuplicates.workspaceId, ws.b), eq(canonicalCustomerDuplicates.matchedSignal, 'phone')));
    await asAdmin(ws.b, () => identity.merge(ws.b, pair.id));

    const rows = await rowsFor(ws.b);
    expect(rows.map((row) => row.canonicalCustomerId)).toEqual([survivor]);
    expect(await summaries.get(ws.b, survivor)).toMatchObject({ summary: { content: 'SURVIVOR-SUMMARY' }, stale: true });
    await expect(summaries.get(ws.b, merged)).rejects.toMatchObject({ code: 'NOT_FOUND', details: { mergedIntoId: survivor } });

    await integrationService.purgeCommerceCustomer(ws.b, integrationIds[`${ws.b}:woocommerce`], 'w1');
    await integrationService.purgeCommerceCustomer(ws.b, integrationIds[`${ws.b}:shopify`], 's1');
    expect(await rowsFor(ws.b)).toHaveLength(0);
    await expect(summaries.get(ws.b, survivor)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Workspace A's summary is untouched by B's erasure.
    expect(await rowsFor(ws.a)).toHaveLength(1);
  });
});
