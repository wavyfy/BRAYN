import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { integrations } from '../../database/schema/integrations';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { websiteVisitors } from '../../database/schema/website-visitors';
import { websiteSessions } from '../../database/schema/website-sessions';
import { websiteEvents } from '../../database/schema/website-events';
import { IntegrationService } from '../integration/integration.service';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { WebsiteTrackingKeyService } from './website-tracking-key.service';
import { WebsiteEventIngestService, identitySignaturePayload, type WebsiteEventRequestContext } from './website-event-ingest.service';
import type { IngestWebsiteEventInput } from './dto/ingest-website-event.schema';

/**
 * Website tracking security against the real dev DB: tenant isolation of
 * keys/visitors/sessions/identity, the session-ownership upsert guard
 * (Postgres `ON CONFLICT ... WHERE`), and signed-only, link-to-existing-only
 * identity resolution. Two throwaway workspaces, deleted in afterAll.
 */
describe('Website tracking security (real DB)', { timeout: 120_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let ingest: WebsiteEventIngestService;
  let customerIntelligence: CustomerIntelligenceService;

  const knownEmail = 'known.shopper@example.com';
  const ws = {
    a: { id: randomUUID(), origin: 'https://a-shop.example', writeKey: '', identitySecret: '', canonicalId: '' },
    b: { id: randomUUID(), origin: 'https://b-shop.example', writeKey: '', identitySecret: '', canonicalId: '' },
  };

  const ctx = (w: typeof ws.a, overrides: Partial<WebsiteEventRequestContext> = {}): WebsiteEventRequestContext => ({
    writeKey: w.writeKey,
    origin: w.origin,
    ip: '127.0.0.1',
    ...overrides,
  });
  const sign = (email: string, secret: string) => createHmac('sha256', secret).update(identitySignaturePayload(email)).digest('hex');
  const event = (overrides: Partial<IngestWebsiteEventInput>): IngestWebsiteEventInput => ({
    visitorId: 'shared-visitor-id',
    sessionId: `session-${randomUUID()}`,
    eventId: `evt-${randomUUID()}`,
    eventType: 'page_view',
    ...overrides,
  });
  const visitorRow = async (workspaceId: string, visitorId: string) =>
    (await db.client.select().from(websiteVisitors).where(and(eq(websiteVisitors.workspaceId, workspaceId), eq(websiteVisitors.visitorId, visitorId))))[0];
  const canonicalCount = async (workspaceId: string) =>
    (await db.client.select({ id: canonicalCustomers.id }).from(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, workspaceId))).length;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    ingest = moduleRef.get(WebsiteEventIngestService);
    customerIntelligence = moduleRef.get(CustomerIntelligenceService);
    const integrationService = moduleRef.get(IntegrationService);
    const keys = moduleRef.get(WebsiteTrackingKeyService);

    for (const w of [ws.a, ws.b]) {
      await db.client.insert(workspaces).values({ id: w.id, name: 'Website Tracking Security Test Workspace' });
      await integrationService.connect(w.id, 'website_tracking');
      w.writeKey = (await keys.generate(w.id)).writeKey;
      w.identitySecret = (await keys.generateIdentitySecret(w.id)).identitySecret;
      await keys.setAllowedOrigins(w.id, [w.origin]);
    }
    // Only workspace A knows this customer (as if imported from a commerce source).
    const [canonical] = await db.client.insert(canonicalCustomers).values({ workspaceId: ws.a.id, primaryEmail: knownEmail }).returning();
    ws.a.canonicalId = canonical.id;
  }, 60_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [ws.a.id, ws.b.id];
    await db.client.delete(websiteEvents).where(inArray(websiteEvents.workspaceId, ids));
    await db.client.delete(websiteSessions).where(inArray(websiteSessions.workspaceId, ids));
    await db.client.delete(websiteVisitors).where(inArray(websiteVisitors.workspaceId, ids));
    await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
    await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    await moduleRef?.close();
  }, 60_000);

  it('rejects workspace A’s write key on workspace B, and B’s origin on A', async () => {
    await expect(ingest.ingest(ws.b.id, event({}), ctx(ws.b, { writeKey: ws.a.writeKey }))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(ingest.ingest(ws.a.id, event({}), ctx(ws.a, { origin: ws.b.origin }))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rejects an unknown workspace with the same 401 as a wrong key', async () => {
    await expect(ingest.ingest(randomUUID(), event({}), ctx(ws.a))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('keeps the same client visitorId in two workspaces as two separate visitor rows', async () => {
    await ingest.ingest(ws.a.id, event({}), ctx(ws.a));
    await ingest.ingest(ws.b.id, event({}), ctx(ws.b));

    const a = await visitorRow(ws.a.id, 'shared-visitor-id');
    const b = await visitorRow(ws.b.id, 'shared-visitor-id');
    expect(a.id).not.toEqual(b.id);
  });

  it('rejects an event that claims another visitor’s session, writing no event row', async () => {
    const sessionId = `session-${randomUUID()}`;
    await ingest.ingest(ws.a.id, event({ visitorId: 'owner-visitor', sessionId }), ctx(ws.a));

    const hijack = event({ visitorId: 'attacker-visitor', sessionId });
    await expect(ingest.ingest(ws.a.id, hijack, ctx(ws.a))).rejects.toMatchObject({ code: 'CONFLICT' });

    const rows = await db.client.select().from(websiteEvents).where(and(eq(websiteEvents.workspaceId, ws.a.id), eq(websiteEvents.eventId, hijack.eventId)));
    expect(rows).toHaveLength(0);
  });

  it('does not link an unsigned identity_signal, and stores it as unverified', async () => {
    const input = event({ visitorId: 'unsigned-visitor', eventType: 'identity_signal', payload: { email: knownEmail } });
    await ingest.ingest(ws.a.id, input, ctx(ws.a));

    expect((await visitorRow(ws.a.id, 'unsigned-visitor')).canonicalCustomerId).toBeNull();
    const [stored] = await db.client.select().from(websiteEvents).where(and(eq(websiteEvents.workspaceId, ws.a.id), eq(websiteEvents.eventId, input.eventId)));
    expect(stored.payload).toEqual({ email: knownEmail, verified: false });
  });

  it('does not link when the signature was made with another workspace’s identity secret', async () => {
    const payload = { email: knownEmail, signature: sign(knownEmail, ws.b.identitySecret) };
    await ingest.ingest(ws.a.id, event({ visitorId: 'cross-secret-visitor', eventType: 'identity_signal', payload }), ctx(ws.a));

    expect((await visitorRow(ws.a.id, 'cross-secret-visitor')).canonicalCustomerId).toBeNull();
  });

  it('never creates a canonical customer from a signed signal for an unknown email', async () => {
    const before = await canonicalCount(ws.a.id);
    const email = `stranger-${randomUUID()}@example.com`;

    await ingest.ingest(ws.a.id, event({ visitorId: 'stranger-visitor', eventType: 'identity_signal', payload: { email, signature: sign(email, ws.a.identitySecret) } }), ctx(ws.a));

    expect(await canonicalCount(ws.a.id)).toBe(before);
    expect((await visitorRow(ws.a.id, 'stranger-visitor')).canonicalCustomerId).toBeNull();
  });

  it('does not link in workspace B to a customer that exists only in workspace A', async () => {
    await ingest.ingest(
      ws.b.id,
      event({ visitorId: 'b-visitor', eventType: 'identity_signal', payload: { email: knownEmail, signature: sign(knownEmail, ws.b.identitySecret) } }),
      ctx(ws.b),
    );

    expect((await visitorRow(ws.b.id, 'b-visitor')).canonicalCustomerId).toBeNull();
    expect(await canonicalCount(ws.b.id)).toBe(0);
  });

  it('links a correctly signed signal to the existing customer, with earlier anonymous events attached in UCIR', async () => {
    await ingest.ingest(ws.a.id, event({ visitorId: 'linking-visitor', eventType: 'product_view', payload: { productId: '1' } }), ctx(ws.a));
    await ingest.ingest(
      ws.a.id,
      event({ visitorId: 'linking-visitor', eventType: 'identity_signal', payload: { email: 'Known.Shopper@Example.com', signature: sign(knownEmail, ws.a.identitySecret) } }),
      ctx(ws.a),
    );

    expect((await visitorRow(ws.a.id, 'linking-visitor')).canonicalCustomerId).toBe(ws.a.canonicalId);
    const customer = await customerIntelligence.getCustomer(ws.a.id, ws.a.canonicalId);
    expect(customer.behaviouralContext.eventsCount).toBe(1);
    expect(customer.behaviouralContext.recentEvents[0].eventType).toBe('product_view');
  });
});
