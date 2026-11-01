import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { and, eq, notInArray } from 'drizzle-orm';
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
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { EventBus } from '../../common/events/event-bus.service';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { CustomerHealthService } from './customer-health.service';
import { RevenueOpportunityService, TERMINAL_STATUSES, type OpportunityType } from './revenue-opportunity.service';
import { RecommendationService } from './recommendation.service';

/**
 * Real-DB checks of the #8 `ignored` recreation rule (user decisions, Nov 1, 2026) for every commerce-derived
 * type: a dismissed opportunity is not recreated from unchanged evidence, and is (except VIP) on new qualifying
 * evidence after the dismissal. Each test gets its own workspace (affinity is workspace-wide); dismissal history is
 * simulated by backdating the ignored row's `closedAt`. Website cross_sell is covered in website-opportunity.db.spec.ts.
 */
// Many sequential round trips to the remote dev database per test — well over the 5s default on a slow link.
describe('Ignored opportunity recreation rule (real DB)', { timeout: 120_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let opportunities: RevenueOpportunityService;
  let recs: RecommendationService;
  const createdWorkspaces: string[] = [];
  const DAY = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * DAY);

  async function workspace() {
    const id = randomUUID();
    createdWorkspaces.push(id);
    await db.client.insert(workspaces).values({ id, name: 'Ignored Opportunity Test Workspace' });
    const [integration] = await db.client.insert(integrations).values({ workspaceId: id, provider: 'shopify' }).returning();
    return { id, integrationId: integration.id };
  }
  type Ws = Awaited<ReturnType<typeof workspace>>;

  /** One product; returns its variant ids in the order of `prices`. */
  async function product(ws: Ws, prices: string[]) {
    const [p] = await db.client.insert(commerceProducts).values({ workspaceId: ws.id, integrationId: ws.integrationId, provider: 'shopify', externalId: randomUUID(), title: 'Test product' }).returning();
    const variants = await db.client
      .insert(commerceProductVariants)
      .values(prices.map((price) => ({ workspaceId: ws.id, integrationId: ws.integrationId, productId: p.id, provider: 'shopify' as const, externalId: randomUUID(), price })))
      .returning();
    return { productId: p.id, variantIds: variants.map((v) => v.id) };
  }
  async function shopper(ws: Ws) {
    const [canonical] = await db.client.insert(canonicalCustomers).values({ workspaceId: ws.id, primaryEmail: `${randomUUID()}@example.com` }).returning();
    const [source] = await db.client
      .insert(commerceCustomers)
      .values({ workspaceId: ws.id, integrationId: ws.integrationId, provider: 'shopify', externalId: randomUUID(), canonicalCustomerId: canonical.id })
      .returning();
    return { canonicalId: canonical.id, sourceId: source.id };
  }
  async function order(ws: Ws, sourceCustomerId: string | null, placedAt: Date, variantIds: string[] = []) {
    const [o] = await db.client
      .insert(commerceOrders)
      .values({ workspaceId: ws.id, integrationId: ws.integrationId, customerId: sourceCustomerId, provider: 'shopify', externalId: randomUUID(), totalPrice: '20.00', sourceCreatedAt: placedAt })
      .returning();
    if (variantIds.length > 0) {
      await db.client
        .insert(commerceOrderLineItems)
        .values(variantIds.map((variantId) => ({ workspaceId: ws.id, integrationId: ws.integrationId, orderId: o.id, variantId, provider: 'shopify' as const, externalId: randomUUID(), quantity: 1, price: '10.00' })));
    }
  }
  const open = (ws: Ws, canonicalId: string, type: OpportunityType) =>
    db.client
      .select()
      .from(revenueOpportunities)
      .where(
        and(
          eq(revenueOpportunities.workspaceId, ws.id),
          eq(revenueOpportunities.canonicalCustomerId, canonicalId),
          eq(revenueOpportunities.type, type),
          notInArray(revenueOpportunities.status, [...TERMINAL_STATUSES]),
        ),
      );
  /** Generates + dismisses the open opportunity of `type` through RecommendationService, then backdates the dismissal. */
  async function dismiss(ws: Ws, canonicalId: string, type: OpportunityType, dismissedDaysAgo: number) {
    await recs.generate(ws.id, canonicalId);
    const [opp] = await open(ws, canonicalId, type);
    const [rec] = await db.client.select().from(recommendations).where(eq(recommendations.sourceOpportunityId, opp.id));
    await recs.dismiss(ws.id, canonicalId, rec.id);
    const [row] = await db.client.select().from(revenueOpportunities).where(eq(revenueOpportunities.id, opp.id));
    expect(row.status).toBe('ignored');
    await db.client.update(revenueOpportunities).set({ closedAt: ago(dismissedDaysAgo) }).where(eq(revenueOpportunities.id, opp.id));
    return row;
  }

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
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    for (const ws of createdWorkspaces) {
      await db.client.delete(recommendations).where(eq(recommendations.workspaceId, ws));
      await db.client.delete(revenueOpportunities).where(eq(revenueOpportunities.workspaceId, ws));
      await db.client.delete(commerceOrderLineItems).where(eq(commerceOrderLineItems.workspaceId, ws));
      await db.client.delete(commerceOrders).where(eq(commerceOrders.workspaceId, ws));
      await db.client.delete(commerceCustomers).where(eq(commerceCustomers.workspaceId, ws));
      await db.client.delete(commerceProductVariants).where(eq(commerceProductVariants.workspaceId, ws));
      await db.client.delete(commerceProducts).where(eq(commerceProducts.workspaceId, ws));
      await db.client.delete(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, ws));
      await db.client.delete(integrations).where(eq(integrations.workspaceId, ws));
      await db.client.delete(workspaces).where(eq(workspaces.id, ws));
    }
    await moduleRef?.close();
  }, 120_000);

  it('reorder: not recreated from the same order history; recreated once an order is placed after the dismissal', async () => {
    const ws = await workspace();
    const c = await shopper(ws);
    for (const d of [60, 50, 40]) await order(ws, c.sourceId, ago(d));
    await opportunities.detect(ws.id, c.canonicalId);
    await dismiss(ws, c.canonicalId, 'reorder', 25);

    await opportunities.detect(ws.id, c.canonicalId);
    expect(await open(ws, c.canonicalId, 'reorder')).toHaveLength(0);

    await order(ws, c.sourceId, ago(20)); // after the dismissal; reorder due again (avg gap ~13 days)
    await opportunities.detect(ws.id, c.canonicalId);
    expect(await open(ws, c.canonicalId, 'reorder')).toHaveLength(1);
  });

  it('win_back: not recreated in the same inactivity cycle; recreated for a new cycle after a post-dismissal order', async () => {
    const ws = await workspace();
    const c = await shopper(ws);
    await order(ws, c.sourceId, ago(300));
    await opportunities.detect(ws.id, c.canonicalId);
    await dismiss(ws, c.canonicalId, 'win_back', 200);

    await opportunities.detect(ws.id, c.canonicalId);
    expect(await open(ws, c.canonicalId, 'win_back')).toHaveLength(0);

    await order(ws, c.sourceId, ago(150)); // after the dismissal, and quiet past 120 days again
    await opportunities.detect(ws.id, c.canonicalId);
    expect(await open(ws, c.canonicalId, 'win_back')).toHaveLength(1);
  });

  it('upsell: unchanged or unrelated purchases do not recreate it; a new qualifying purchase after the dismissal does', async () => {
    const ws = await workspace();
    const c = await shopper(ws);
    const mug = await product(ws, ['10.00', '20.00']);
    const plain = await product(ws, ['5.00']);
    const tea = await product(ws, ['5.00', '8.00']);
    await order(ws, c.sourceId, ago(10), [mug.variantIds[0]]);
    await opportunities.detect(ws.id, c.canonicalId);
    await dismiss(ws, c.canonicalId, 'upsell', 5);

    await opportunities.detect(ws.id, c.canonicalId);
    expect(await open(ws, c.canonicalId, 'upsell')).toHaveLength(0);

    await order(ws, c.sourceId, ago(3), [plain.variantIds[0]]); // after the dismissal, but no upsell for it
    await opportunities.detect(ws.id, c.canonicalId);
    expect(await open(ws, c.canonicalId, 'upsell')).toHaveLength(0);

    await order(ws, c.sourceId, ago(2), [tea.variantIds[0]]); // new qualifying purchase
    await opportunities.detect(ws.id, c.canonicalId);
    const [recreated] = await open(ws, c.canonicalId, 'upsell');
    expect(recreated.estimatedRevenue).toBe('3.00');
  });

  it('vip_recognition: never recreated once dismissed, even after new orders', async () => {
    const ws = await workspace();
    const c = await shopper(ws);
    for (let i = 0; i < 10; i++) await order(ws, c.sourceId, ago(95 - i * 10)); // last order 5 days ago: reorder not due
    await opportunities.detect(ws.id, c.canonicalId);
    await dismiss(ws, c.canonicalId, 'vip_recognition', 30);

    await order(ws, c.sourceId, ago(1));
    await opportunities.detect(ws.id, c.canonicalId);
    expect(await open(ws, c.canonicalId, 'vip_recognition')).toHaveLength(0);
  });

  it('commerce cross_sell: the same pair is not recreated; a different qualifying pair is, and stores its pair', async () => {
    const ws = await workspace();
    const c = await shopper(ws);
    const [a, b, cc, filler] = [await product(ws, ['10.00']), await product(ws, ['12.00']), await product(ws, ['14.00']), await product(ws, ['1.00'])];
    await order(ws, c.sourceId, ago(5), [a.variantIds[0]]);
    for (let i = 0; i < 3; i++) await order(ws, null, ago(20), [a.variantIds[0], b.variantIds[0]]);
    for (let i = 0; i < 6; i++) await order(ws, null, ago(20), [a.variantIds[0]]);
    for (let i = 0; i < 11; i++) await order(ws, null, ago(20), [filler.variantIds[0]]); // 21 workspace orders; A in 10, B ratio 0.3
    await opportunities.detect(ws.id, c.canonicalId);
    const ignored = await dismiss(ws, c.canonicalId, 'cross_sell', 3);
    expect(ignored).toMatchObject({ affinityOwnedProductId: a.productId, affinityOtherProductId: b.productId, evidenceAt: null });

    await opportunities.detect(ws.id, c.canonicalId);
    expect(await open(ws, c.canonicalId, 'cross_sell')).toHaveLength(0);

    for (let i = 0; i < 4; i++) await order(ws, null, ago(1), [a.variantIds[0], cc.variantIds[0]]); // C ratio 4/14 now beats B's 3/14
    await opportunities.detect(ws.id, c.canonicalId);
    const [recreated] = await open(ws, c.canonicalId, 'cross_sell');
    expect(recreated).toMatchObject({ affinityOwnedProductId: a.productId, affinityOtherProductId: cc.productId });
  });

  it('bundle: the same pair is not recreated; a different qualifying pair is', async () => {
    const ws = await workspace();
    const c = await shopper(ws);
    const [a, b, cc, filler] = [await product(ws, ['10.00']), await product(ws, ['12.00']), await product(ws, ['14.00']), await product(ws, ['1.00'])];
    await order(ws, c.sourceId, ago(5), [a.variantIds[0]]);
    for (let i = 0; i < 5; i++) await order(ws, null, ago(20), [a.variantIds[0], b.variantIds[0]]);
    for (let i = 0; i < 4; i++) await order(ws, null, ago(20), [a.variantIds[0]]);
    for (let i = 0; i < 11; i++) await order(ws, null, ago(20), [filler.variantIds[0]]); // A in 10, B ratio 0.5
    await opportunities.detect(ws.id, c.canonicalId);
    const ignored = await dismiss(ws, c.canonicalId, 'bundle', 3);
    expect(ignored).toMatchObject({ affinityOwnedProductId: a.productId, affinityOtherProductId: b.productId });

    await opportunities.detect(ws.id, c.canonicalId);
    expect(await open(ws, c.canonicalId, 'bundle')).toHaveLength(0);

    for (let i = 0; i < 7; i++) await order(ws, null, ago(1), [a.variantIds[0], cc.variantIds[0]]); // C ratio 7/17 ≥ 0.4
    await opportunities.detect(ws.id, c.canonicalId);
    const [recreated] = await open(ws, c.canonicalId, 'bundle');
    expect(recreated).toMatchObject({ affinityOwnedProductId: a.productId, affinityOtherProductId: cc.productId });
  });

  it('one customer\'s ignored opportunity never suppresses another customer or workspace', async () => {
    const ws = await workspace();
    const otherWs = await workspace();
    const [x, y, z] = [await shopper(ws), await shopper(ws), await shopper(otherWs)];
    for (const d of [60, 50, 40]) {
      await order(ws, x.sourceId, ago(d));
      await order(ws, y.sourceId, ago(d));
      await order(otherWs, z.sourceId, ago(d));
    }
    await opportunities.detect(ws.id, x.canonicalId);
    await dismiss(ws, x.canonicalId, 'reorder', 25);

    await opportunities.detect(ws.id, y.canonicalId);
    await opportunities.detect(otherWs.id, z.canonicalId);
    expect(await open(ws, x.canonicalId, 'reorder')).toHaveLength(0);
    expect(await open(ws, y.canonicalId, 'reorder')).toHaveLength(1);
    expect(await open(otherWs, z.canonicalId, 'reorder')).toHaveLength(1);
  });
});
