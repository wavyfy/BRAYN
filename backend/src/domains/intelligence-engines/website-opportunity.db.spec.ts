import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { and, eq, inArray } from 'drizzle-orm';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { loadConfiguration } from '../../config/configuration';
import { workspaces } from '../../database/schema/workspaces';
import { integrations } from '../../database/schema/integrations';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceProducts } from '../../database/schema/commerce-products';
import { commerceProductVariants } from '../../database/schema/commerce-product-variants';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { commerceOrderLineItems } from '../../database/schema/commerce-order-line-items';
import { websiteVisitors } from '../../database/schema/website-visitors';
import { websiteSessions } from '../../database/schema/website-sessions';
import { websiteEvents } from '../../database/schema/website-events';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { EventBus } from '../../common/events/event-bus.service';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { CustomerHealthService } from './customer-health.service';
import { RevenueOpportunityService } from './revenue-opportunity.service';
import { RecommendationService } from './recommendation.service';

/**
 * Real-DB checks of website-derived cross_sell (Milestone #5 Release 3), same approach
 * as provider-parity.db.spec.ts: an isolated workspace, every row deleted afterwards.
 * Proves what mocks can't: the JSON payload extraction, catalogue validation, linked-
 * visitor scoping, purchase lookup, and the expiry/recreation writes.
 */
// Many sequential round trips to the remote dev database per test — well over the 5s default on a slow link.
describe('Website-derived revenue opportunities (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let opportunities: RevenueOpportunityService;
  let recs: RecommendationService;
  let ucir: CustomerIntelligenceService;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  let integrationId: string;
  let otherIntegrationId: string;
  const product: Record<string, string> = {};
  const H = 60 * 60 * 1000;
  const ago = (hours: number) => new Date(Date.now() - hours * H);

  async function customer(ws = workspaceId) {
    const [row] = await db.client.insert(canonicalCustomers).values({ workspaceId: ws, primaryEmail: `${randomUUID()}@example.com` }).returning();
    return row.id;
  }
  async function visitor(canonicalCustomerId: string | null, ws = workspaceId) {
    const [row] = await db.client.insert(websiteVisitors).values({ workspaceId: ws, visitorId: randomUUID(), canonicalCustomerId }).returning();
    return row.id;
  }
  async function session(visitorId: string, ws = workspaceId) {
    const [row] = await db.client.insert(websiteSessions).values({ workspaceId: ws, visitorId, sessionKey: randomUUID() }).returning();
    return row.id;
  }
  async function event(visitorId: string, sessionId: string, eventType: 'product_view' | 'cart', payload: Record<string, unknown>, occurredAt: Date, ws = workspaceId) {
    await db.client.insert(websiteEvents).values({ workspaceId: ws, visitorId, sessionId, eventId: randomUUID(), eventType, payload, occurredAt });
  }
  /** 3 views of `externalId` across 2 sessions, the latest `latestHoursAgo` ago. */
  async function threeViews(visitorId: string, externalId: string | number, latestHoursAgo = 1) {
    const [s1, s2] = [await session(visitorId), await session(visitorId)];
    await event(visitorId, s1, 'product_view', { productId: externalId }, ago(latestHoursAgo + 48));
    await event(visitorId, s1, 'product_view', { productId: externalId }, ago(latestHoursAgo + 47));
    await event(visitorId, s2, 'product_view', { productId: externalId }, ago(latestHoursAgo));
  }
  const openWebsite = (canonicalCustomerId: string) =>
    db.client
      .select()
      .from(revenueOpportunities)
      .where(and(eq(revenueOpportunities.workspaceId, workspaceId), eq(revenueOpportunities.canonicalCustomerId, canonicalCustomerId)));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [loadConfiguration] }), DatabaseModule],
      providers: [
        RevenueOpportunityService,
        RecommendationService,
        CustomerIntelligenceService,
        { provide: CustomerHealthService, useValue: { findCurrent: vi.fn(async () => null) } },
        { provide: EventBus, useValue: { emit: vi.fn() } },
        { provide: StructuredLoggerService, useValue: { event: vi.fn() } },
      ],
    }).compile();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    opportunities = moduleRef.get(RevenueOpportunityService);
    recs = moduleRef.get(RecommendationService);
    ucir = moduleRef.get(CustomerIntelligenceService);

    await db.client.insert(workspaces).values([
      { id: workspaceId, name: 'Website Opportunity Test Workspace' },
      { id: otherWorkspaceId, name: 'Website Opportunity Test Workspace (other)' },
    ]);
    [{ id: integrationId }] = await db.client.insert(integrations).values({ workspaceId, provider: 'shopify' }).returning();
    [{ id: otherIntegrationId }] = await db.client.insert(integrations).values({ workspaceId: otherWorkspaceId, provider: 'shopify' }).returning();

    for (const [key, externalId, price] of [
      ['kettle', '1001', '40.00'],
      ['grinder', '1002', '120.00'],
      ['beans', '1003', '15.50'],
    ] as const) {
      const [p] = await db.client.insert(commerceProducts).values({ workspaceId, integrationId, provider: 'shopify', externalId, title: `Test ${key}` }).returning();
      product[key] = p.id;
      await db.client.insert(commerceProductVariants).values([
        { workspaceId, integrationId, productId: p.id, provider: 'shopify', externalId: `${externalId}-a`, price },
        { workspaceId, integrationId, productId: p.id, provider: 'shopify', externalId: `${externalId}-b`, price: '999.00' },
      ]);
    }
    // Same external id in another workspace — must never leak across.
    await db.client.insert(commerceProducts).values({ workspaceId: otherWorkspaceId, integrationId: otherIntegrationId, provider: 'shopify', externalId: '1001', title: 'Other kettle' });
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await db.client.delete(recommendations).where(eq(recommendations.workspaceId, ws));
      await db.client.delete(revenueOpportunities).where(eq(revenueOpportunities.workspaceId, ws));
      await db.client.delete(websiteEvents).where(eq(websiteEvents.workspaceId, ws));
      await db.client.delete(websiteSessions).where(eq(websiteSessions.workspaceId, ws));
      await db.client.delete(websiteVisitors).where(eq(websiteVisitors.workspaceId, ws));
      await db.client.delete(commerceOrderLineItems).where(eq(commerceOrderLineItems.workspaceId, ws));
      await db.client.delete(commerceOrders).where(eq(commerceOrders.workspaceId, ws));
      await db.client.delete(commerceCustomers).where(eq(commerceCustomers.workspaceId, ws));
      await db.client.delete(commerceProductVariants).where(eq(commerceProductVariants.workspaceId, ws));
      await db.client.delete(commerceProducts).where(eq(commerceProducts.workspaceId, ws));
      await db.client.delete(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, ws));
      await db.client.delete(integrations).where(eq(integrations.workspaceId, ws));
    }
    await db.client.delete(workspaces).where(inArray(workspaces.id, [workspaceId, otherWorkspaceId]));
    await moduleRef?.close();
  }, 60_000);

  it('UCIR evidence: validates product ids against the catalogue, ignores names/unknown ids/removals/anonymous visitors, numeric ids match', async () => {
    const id = await customer();
    const v = await visitor(id);
    const s = await session(v);
    await event(v, s, 'product_view', { productId: 1001 }, ago(2)); // JSON number → still "1001"
    await event(v, s, 'product_view', { product: 'Test kettle' }, ago(2)); // name only
    await event(v, s, 'product_view', { productId: '9999' }, ago(2)); // not in catalogue
    await event(v, s, 'cart', { action: 'remove', productId: '1002' }, ago(30));
    await event(v, s, 'cart', { action: 'add', productId: '1002', quantity: 'lots' }, ago(30));
    const anon = await visitor(null);
    await event(anon, await session(anon), 'product_view', { productId: '1003' }, ago(2));

    const intents = await ucir.getWebsiteProductIntent(workspaceId, id, ago(7 * 24), new Date());

    expect(intents.map((i) => i.productId).sort()).toEqual([product.kettle, product.grinder].sort());
    expect(intents.find((i) => i.productId === product.kettle)!.views).toHaveLength(1);
    expect(intents.find((i) => i.productId === product.grinder)!.cartAdds).toEqual([{ occurredAt: expect.any(Date), quantity: 1 }]);
  });

  it('creates a medium-confidence cross_sell from 3 views across 2 sessions — only when the scheduled run asks (includeWebsite)', async () => {
    const id = await customer();
    await threeViews(await visitor(id), '1001');

    await opportunities.detect(workspaceId, id);
    expect(await openWebsite(id)).toHaveLength(0);

    await opportunities.detect(workspaceId, id, { includeWebsite: true });
    const [opp] = await openWebsite(id);
    expect(opp).toMatchObject({ type: 'cross_sell', confidence: 60, estimatedRevenue: '40.00', evidenceProductId: product.kettle, status: 'new' });
    expect(opp.reason).toContain('viewed "Test kettle" 3 times across 2 website sessions');

    await opportunities.detect(workspaceId, id, { includeWebsite: true });
    expect(await openWebsite(id)).toHaveLength(1);
  });

  it('creates a high-confidence cross_sell from a 24h+ cart add, revenue = lowest price × quantity; a fresh cart add does not qualify', async () => {
    const fresh = await customer();
    const fv = await visitor(fresh);
    await event(fv, await session(fv), 'cart', { action: 'add', productId: '1003', quantity: 2 }, ago(2));
    await opportunities.detect(workspaceId, fresh, { includeWebsite: true });
    expect(await openWebsite(fresh)).toHaveLength(0);

    const id = await customer();
    const v = await visitor(id);
    await event(v, await session(v), 'cart', { action: 'add', productId: '1003', quantity: 2 }, ago(25));
    await opportunities.detect(workspaceId, id, { includeWebsite: true });
    expect((await openWebsite(id))[0]).toMatchObject({ type: 'cross_sell', confidence: 80, estimatedRevenue: '31.00', evidenceProductId: product.beans });
  });

  it('does not offer a product the customer has purchased', async () => {
    const id = await customer();
    const [cc] = await db.client.insert(commerceCustomers).values({ workspaceId, integrationId, provider: 'shopify', externalId: randomUUID(), canonicalCustomerId: id }).returning();
    const [order] = await db.client
      .insert(commerceOrders)
      .values({ workspaceId, integrationId, customerId: cc.id, provider: 'shopify', externalId: randomUUID(), totalPrice: '120.00', sourceCreatedAt: ago(24 * 30) })
      .returning();
    const [variant] = await db.client.select().from(commerceProductVariants).where(eq(commerceProductVariants.productId, product.grinder)).limit(1);
    await db.client.insert(commerceOrderLineItems).values({ workspaceId, integrationId, orderId: order.id, variantId: variant.id, provider: 'shopify', externalId: randomUUID(), quantity: 1 });
    await threeViews(await visitor(id), '1002');

    const [intent] = await ucir.getWebsiteProductIntent(workspaceId, id, ago(7 * 24), new Date());
    expect(Math.abs(intent.lastPurchasedAt!.getTime() - ago(24 * 30).getTime())).toBeLessThan(60_000);

    await opportunities.detect(workspaceId, id, { includeWebsite: true });
    expect((await openWebsite(id)).filter((o) => o.evidenceProductId)).toHaveLength(0);
  });

  it('expires a stale website opportunity after 7 days, dismisses its recommendation, and recreates only on new evidence after the closure', async () => {
    const id = await customer();
    const v = await visitor(id);
    await threeViews(v, '1001', 2);
    await opportunities.detect(workspaceId, id, { includeWebsite: true });
    await recs.generate(workspaceId, id);
    const [opp] = await openWebsite(id);
    const [rec] = await db.client.select().from(recommendations).where(eq(recommendations.sourceOpportunityId, opp.id));
    expect(rec.state).toBe('active');
    expect(opp.status).toBe('recommended'); // a surfaced opportunity still expires below

    // Evidence goes stale (no qualifying event for 8 days).
    await db.client.update(revenueOpportunities).set({ evidenceAt: ago(8 * 24) }).where(eq(revenueOpportunities.id, opp.id));
    await db.client.delete(websiteEvents).where(and(eq(websiteEvents.workspaceId, workspaceId), eq(websiteEvents.visitorId, v)));
    await opportunities.detect(workspaceId, id, { includeWebsite: true });

    const [expired] = await db.client.select().from(revenueOpportunities).where(eq(revenueOpportunities.id, opp.id));
    expect(expired).toMatchObject({ status: 'expired', closedReason: 'Website evidence no longer fresh (7 days).' });
    const [dismissed] = await db.client.select().from(recommendations).where(eq(recommendations.id, rec.id));
    expect(dismissed.state).toBe('dismissed');

    // Old evidence (from before the closure) back in the window: no recreation.
    const s = await session(v);
    for (const h of [50, 49, 3]) await event(v, h === 3 ? await session(v) : s, 'product_view', { productId: '1001' }, ago(h));
    await opportunities.detect(workspaceId, id, { includeWebsite: true });
    expect((await openWebsite(id)).filter((o) => o.status === 'new')).toHaveLength(0);

    // New qualifying evidence after the closure: recreated.
    const [n1, n2] = [await session(v), await session(v)];
    await event(v, n1, 'product_view', { productId: '1001' }, new Date());
    await event(v, n1, 'product_view', { productId: '1001' }, new Date());
    await event(v, n2, 'product_view', { productId: '1001' }, new Date());
    await opportunities.detect(workspaceId, id, { includeWebsite: true });
    const reopened = (await openWebsite(id)).filter((o) => o.status === 'new');
    expect(reopened).toHaveLength(1);
    expect(reopened[0]).toMatchObject({ evidenceProductId: product.kettle, type: 'cross_sell' });
  });

  it('refreshes an open website opportunity while evidence stays fresh, so it does not expire', async () => {
    const id = await customer();
    const v = await visitor(id);
    await threeViews(v, '1002', 5);
    await opportunities.detect(workspaceId, id, { includeWebsite: true });
    const [opp] = await openWebsite(id);

    await db.client.update(revenueOpportunities).set({ evidenceAt: ago(8 * 24) }).where(eq(revenueOpportunities.id, opp.id)); // recorded evidence old…
    await opportunities.detect(workspaceId, id, { includeWebsite: true }); // …but the views are still in the window

    const [after] = await db.client.select().from(revenueOpportunities).where(eq(revenueOpportunities.id, opp.id));
    expect(after.status).toBe('new');
    expect(after.evidenceAt!.getTime()).toBeGreaterThan(ago(6).getTime());
  });

  it('never reads another workspace: the same visitor activity in another workspace produces nothing here', async () => {
    const id = await customer();
    const otherCustomer = await customer(otherWorkspaceId);
    const ov = await visitor(otherCustomer, otherWorkspaceId);
    const [s1, s2] = [await session(ov, otherWorkspaceId), await session(ov, otherWorkspaceId)];
    for (const [s, h] of [[s1, 3], [s1, 2], [s2, 1]] as const) await event(ov, s, 'product_view', { productId: '1001' }, ago(h), otherWorkspaceId);

    expect(await ucir.getWebsiteProductIntent(workspaceId, id, ago(7 * 24), new Date())).toEqual([]);
    expect(await ucir.getWebsiteProductIntent(workspaceId, otherCustomer, ago(7 * 24), new Date())).toEqual([]);
  });
});
