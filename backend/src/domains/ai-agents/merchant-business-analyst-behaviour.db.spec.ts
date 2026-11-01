import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { users } from '../../database/schema/users';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { websiteVisitors } from '../../database/schema/website-visitors';
import { websiteSessions } from '../../database/schema/website-sessions';
import { websiteEvents } from '../../database/schema/website-events';
import { protectedDataAccessLog } from '../../database/schema/protected-data-access-log';
import { RequestContext } from '../../common/logging/request-context';
import { AiGatewayService } from '../ai/ai-gateway.service';
import type { AiMessage } from '../ai/ai-provider.interface';
import { MerchantBusinessAnalystService } from './merchant-business-analyst.service';

/**
 * #7 "Customer behavioural context → AI" against the real dev DB and the real Nest wiring
 * (only the AI Gateway is stubbed, to capture what the model would be sent): linked-visitor
 * website events reach the Analyst for owner/admin, never for other roles, never from an
 * unlinked visitor or another workspace, and never with event payloads. Throwaway rows,
 * deleted in afterAll.
 */
describe('Merchant Business Analyst — behavioural context (real DB)', { timeout: 90_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let analyst: MerchantBusinessAnalystService;
  const generate = vi.fn<(request: { messages: AiMessage[] }) => Promise<{ content: string; model: string; provider: string }>>(async () => ({
    content: 'answer',
    model: 'stub',
    provider: 'stub',
  }));
  const ws = { a: randomUUID(), b: randomUUID() };
  let userId = '';
  let customerA = '';
  let quietCustomer = '';
  const behaviourBlock = () =>
    (generate.mock.calls.at(-1)?.[0].messages ?? []).map((m) => m.content).find((c) => c.includes('CATEGORY: Observed website behaviour'));
  const as = <T>(workspaceId: string, actorRole: string, fn: () => Promise<T>) =>
    RequestContext.run({ correlationId: randomUUID(), workspaceId, actorUserId: userId, actorRole } as never, fn);

  async function track(workspaceId: string, canonicalCustomerId: string | null, events: [string, Record<string, unknown>, Date][]) {
    const [visitor] = await db.client.insert(websiteVisitors).values({ workspaceId, visitorId: randomUUID(), canonicalCustomerId }).returning();
    const [session] = await db.client.insert(websiteSessions).values({ workspaceId, visitorId: visitor.id, sessionKey: randomUUID() }).returning();
    for (const [eventType, payload, occurredAt] of events) {
      await db.client.insert(websiteEvents).values({
        workspaceId,
        visitorId: visitor.id,
        sessionId: session.id,
        eventId: randomUUID(),
        eventType: eventType as 'page_view',
        payload,
        occurredAt,
      });
    }
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(AiGatewayService).useValue({ generate }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    analyst = moduleRef.get(MerchantBusinessAnalystService);

    await db.client.insert(workspaces).values([
      { id: ws.a, name: 'MBA Behaviour Test Workspace' },
      { id: ws.b, name: 'MBA Behaviour Test Workspace (other)' },
    ]);
    [{ id: userId }] = await db.client.insert(users).values({ clerkUserId: `test_mba_behaviour_${randomUUID()}` }).returning({ id: users.id });
    [{ id: customerA }, { id: quietCustomer }] = await db.client
      .insert(canonicalCustomers)
      .values([{ workspaceId: ws.a, primaryEmail: `a-${randomUUID()}@example.com` }, { workspaceId: ws.a, primaryEmail: `q-${randomUUID()}@example.com` }])
      .returning();

    await track(ws.a, customerA, [
      ['page_view', { path: '/secret-landing' }, new Date('2026-10-30T10:00:00Z')],
      ['product_view', { productId: 'SKU-PAYLOAD-MARKER' }, new Date('2026-10-31T09:00:00Z')],
      ['identity_signal', { email: 'linked@example.com' }, new Date('2026-10-31T09:01:00Z')],
    ]);
    // An unlinked visitor, and the same customer id under another workspace: neither may reach the model.
    await track(ws.a, null, [['cart', { action: 'add' }, new Date('2026-10-31T12:00:00Z')]]);
    await track(ws.b, null, [['search', { query: 'other-workspace' }, new Date('2026-10-31T12:00:00Z')]]);
  }, 90_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [ws.a, ws.b];
    await db.client.delete(protectedDataAccessLog).where(inArray(protectedDataAccessLog.workspaceId, ids));
    await db.client.delete(websiteEvents).where(inArray(websiteEvents.workspaceId, ids));
    await db.client.delete(websiteSessions).where(inArray(websiteSessions.workspaceId, ids));
    await db.client.delete(websiteVisitors).where(inArray(websiteVisitors.workspaceId, ids));
    await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    if (userId) await db.client.delete(users).where(eq(users.id, userId));
    await moduleRef?.close();
  }, 60_000);

  it('owner/admin: linked-visitor events reach the model as types and times only — no payloads, no identity signals, no unlinked visitors', async () => {
    await as(ws.a, 'admin', () => analyst.ask(ws.a, 'Is this customer engaged on the website?', customerA));

    const block = behaviourBlock();
    expect(block).toContain('- Website events recorded: 2');
    expect(block).toContain('- Last website activity: 2026-10-31T09:00:00.000Z');
    expect(block).toContain('product_view at 2026-10-31T09:00:00.000Z; page_view at 2026-10-30T10:00:00.000Z');
    const sent = JSON.stringify(generate.mock.calls.at(-1)?.[0].messages);
    for (const leak of ['SKU-PAYLOAD-MARKER', '/secret-landing', 'linked@example.com', 'identity_signal', 'cart at', 'other-workspace']) {
      expect(sent).not.toContain(leak);
    }
  });

  it('a customer with no linked activity gets the explicit "none recorded" line', async () => {
    await as(ws.a, 'owner', () => analyst.ask(ws.a, 'question', quietCustomer));

    expect(behaviourBlock()).toContain('- No website activity recorded for this customer.');
  });

  it('roles without customer-fact access never receive behavioural context', async () => {
    await as(ws.a, 'support', () => analyst.ask(ws.a, 'question', customerA));

    expect(behaviourBlock()).toBeUndefined();
  });

  it('records the protected-data access for the owner/admin request that received it', async () => {
    const rows = await db.client.select().from(protectedDataAccessLog).where(eq(protectedDataAccessLog.workspaceId, ws.a));
    expect(rows.some((row) => row.resourceId === customerA)).toBe(true);
  });
});
