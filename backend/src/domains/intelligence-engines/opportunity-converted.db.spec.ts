import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
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
import { createEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { CustomerHealthService } from './customer-health.service';
import { RevenueOpportunityService } from './revenue-opportunity.service';
import { RecommendationService } from './recommendation.service';

type OpportunityInsert = typeof revenueOpportunities.$inferInsert;

/**
 * Real-DB checks of the #8 `converted` outcome (user decisions, Nov 1, 2026): an executed opportunity converts on a
 * non-cancelled order placed after execution (completed recommendation's `closedAt`) and within 7 days, product-specific
 * types only on their stored product/variant. Execution time is simulated by backdating the recommendation's `closedAt`.
 */
// Many sequential round trips to the remote dev database per test — well over the 5s default on a slow link.
describe('Converted opportunity outcome (real DB)', { timeout: 120_000 }, () => {
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
    await db.client.insert(workspaces).values({ id, name: 'Converted Opportunity Test Workspace' });
    const [integration] = await db.client.insert(integrations).values({ workspaceId: id, provider: 'shopify' }).returning();
    return { id, integrationId: integration.id };
  }
  type Ws = Awaited<ReturnType<typeof workspace>>;
  let ws: Ws;

  async function product(prices: string[], w = ws) {
    const [p] = await db.client.insert(commerceProducts).values({ workspaceId: w.id, integrationId: w.integrationId, provider: 'shopify', externalId: randomUUID(), title: 'Test product' }).returning();
    const variants = await db.client
      .insert(commerceProductVariants)
      .values(prices.map((price) => ({ workspaceId: w.id, integrationId: w.integrationId, productId: p.id, provider: 'shopify' as const, externalId: randomUUID(), price })))
      .returning();
    return { productId: p.id, variantIds: variants.map((v) => v.id) };
  }
  async function shopper(w = ws) {
    const [canonical] = await db.client.insert(canonicalCustomers).values({ workspaceId: w.id, primaryEmail: `${randomUUID()}@example.com` }).returning();
    const [source] = await db.client
      .insert(commerceCustomers)
      .values({ workspaceId: w.id, integrationId: w.integrationId, provider: 'shopify', externalId: randomUUID(), canonicalCustomerId: canonical.id })
      .returning();
    return { canonicalId: canonical.id, sourceId: source.id };
  }
  async function order(sourceCustomerId: string, placedAt: Date, variantIds: string[] = [], options: { cancelled?: boolean; w?: Ws } = {}) {
    const w = options.w ?? ws;
    const [o] = await db.client
      .insert(commerceOrders)
      .values({
        workspaceId: w.id,
        integrationId: w.integrationId,
        customerId: sourceCustomerId,
        provider: 'shopify',
        externalId: randomUUID(),
        totalPrice: '20.00',
        sourceCreatedAt: placedAt,
        sourceCancelledAt: options.cancelled ? placedAt : null,
      })
      .returning();
    if (variantIds.length > 0) {
      await db.client
        .insert(commerceOrderLineItems)
        .values(variantIds.map((variantId) => ({ workspaceId: w.id, integrationId: w.integrationId, orderId: o.id, variantId, provider: 'shopify' as const, externalId: randomUUID(), quantity: 1, price: '10.00' })));
    }
    return o.id;
  }
  /** Inserts an opportunity, executes it through RecommendationService (generate → complete), then backdates the execution. */
  async function executed(canonicalId: string, fields: Partial<OpportunityInsert> & Pick<OpportunityInsert, 'type'>, executedDaysAgo: number, w = ws) {
    const [opp] = await db.client
      .insert(revenueOpportunities)
      .values({ workspaceId: w.id, canonicalCustomerId: canonicalId, priority: 'high', confidence: 80, reason: 'r', recommendedAction: 'a', ...fields })
      .returning();
    await recs.generate(w.id, canonicalId);
    const [rec] = await db.client.select().from(recommendations).where(eq(recommendations.sourceOpportunityId, opp.id));
    await recs.complete(w.id, canonicalId, rec.id);
    await db.client.update(recommendations).set({ closedAt: ago(executedDaysAgo) }).where(eq(recommendations.id, rec.id));
    return opp.id;
  }
  async function opportunity(id: string) {
    const [row] = await db.client.select().from(revenueOpportunities).where(eq(revenueOpportunities.id, id));
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
    ws = await workspace();
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    for (const id of createdWorkspaces) {
      await db.client.delete(recommendations).where(eq(recommendations.workspaceId, id));
      await db.client.delete(revenueOpportunities).where(eq(revenueOpportunities.workspaceId, id));
      await db.client.delete(commerceOrderLineItems).where(eq(commerceOrderLineItems.workspaceId, id));
      await db.client.delete(commerceOrders).where(eq(commerceOrders.workspaceId, id));
      await db.client.delete(commerceCustomers).where(eq(commerceCustomers.workspaceId, id));
      await db.client.delete(commerceProductVariants).where(eq(commerceProductVariants.workspaceId, id));
      await db.client.delete(commerceProducts).where(eq(commerceProducts.workspaceId, id));
      await db.client.delete(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, id));
      await db.client.delete(integrations).where(eq(integrations.workspaceId, id));
      await db.client.delete(workspaces).where(eq(workspaces.id, id));
    }
    await moduleRef?.close();
  }, 120_000);

  it('converts on an order placed after execution within 7 days, once — a repeat run is a no-op', async () => {
    const c = await shopper();
    const opp = await executed(c.canonicalId, { type: 'reorder' }, 5);
    await order(c.sourceId, ago(3));

    expect(await opportunities.evaluateConversions(ws.id, c.canonicalId)).toBe(1);
    expect(await opportunity(opp)).toMatchObject({ status: 'converted', closedReason: 'converted_by_order' });
    const closedAt = (await opportunity(opp)).closedAt;

    await order(c.sourceId, ago(2));
    expect(await opportunities.evaluateConversions(ws.id, c.canonicalId)).toBe(0);
    expect((await opportunity(opp)).closedAt).toEqual(closedAt);
  });

  it('does not convert on orders before execution, after the 7-day window, or cancelled', async () => {
    const before = await shopper();
    const late = await shopper();
    const cancelled = await shopper();
    const oppBefore = await executed(before.canonicalId, { type: 'win_back' }, 5);
    const oppLate = await executed(late.canonicalId, { type: 'vip_recognition' }, 10);
    const oppCancelled = await executed(cancelled.canonicalId, { type: 'reorder' }, 5);
    await order(before.sourceId, ago(6));
    await order(late.sourceId, ago(2)); // 8 days after execution
    await order(cancelled.sourceId, ago(3), [], { cancelled: true });

    for (const c of [before, late, cancelled]) expect(await opportunities.evaluateConversions(ws.id, c.canonicalId)).toBe(0);
    for (const id of [oppBefore, oppLate, oppCancelled]) expect((await opportunity(id)).status).toBe('executed');
  });

  it('product-specific types convert only on their stored product/variant; legacy rows without one never convert', async () => {
    const c = await shopper();
    const [a, b, p, q, mug] = [await product(['10.00']), await product(['12.00']), await product(['15.00']), await product(['9.00']), await product(['10.00', '20.00'])];
    const website = await executed(c.canonicalId, { type: 'cross_sell', evidenceProductId: p.productId, evidenceAt: ago(8) }, 5);
    const bundle = await executed(c.canonicalId, { type: 'bundle', affinityOwnedProductId: a.productId, affinityOtherProductId: b.productId }, 5);
    const upsell = await executed(c.canonicalId, { type: 'upsell', upsellTargetVariantId: mug.variantIds[1] }, 5);

    // Wrong products/variant: the owned product of the pair, an unrelated product, the cheaper variant.
    await order(c.sourceId, ago(4), [a.variantIds[0], q.variantIds[0], mug.variantIds[0]]);
    expect(await opportunities.evaluateConversions(ws.id, c.canonicalId)).toBe(0);

    await order(c.sourceId, ago(3), [p.variantIds[0], b.variantIds[0], mug.variantIds[1]]);
    expect(await opportunities.evaluateConversions(ws.id, c.canonicalId)).toBe(3);
    for (const id of [website, bundle, upsell]) expect((await opportunity(id)).status).toBe('converted');

    const legacy = await shopper();
    const legacyCrossSell = await executed(legacy.canonicalId, { type: 'cross_sell' }, 5);
    const legacyUpsell = await executed(legacy.canonicalId, { type: 'upsell' }, 5);
    await order(legacy.sourceId, ago(3), [a.variantIds[0], b.variantIds[0], p.variantIds[0], mug.variantIds[1]]);
    expect(await opportunities.evaluateConversions(ws.id, legacy.canonicalId)).toBe(0);
    for (const id of [legacyCrossSell, legacyUpsell]) expect((await opportunity(id)).status).toBe('executed');
  });

  it('commerce cross_sell converts on the recommended other product', async () => {
    const c = await shopper();
    const [a, b] = [await product(['10.00']), await product(['12.00'])];
    const opp = await executed(c.canonicalId, { type: 'cross_sell', affinityOwnedProductId: a.productId, affinityOtherProductId: b.productId }, 5);
    await order(c.sourceId, ago(4), [a.variantIds[0]]);
    expect(await opportunities.evaluateConversions(ws.id, c.canonicalId)).toBe(0);
    await order(c.sourceId, ago(3), [b.variantIds[0]]);
    expect(await opportunities.evaluateConversions(ws.id, c.canonicalId)).toBe(1);
    expect((await opportunity(opp)).status).toBe('converted');
  });

  it('only executed opportunities convert; a non-executed one and an executed one with no order stay as they are', async () => {
    const c = await shopper();
    const [recommended] = await db.client
      .insert(revenueOpportunities)
      .values({ workspaceId: ws.id, canonicalCustomerId: c.canonicalId, type: 'win_back', status: 'recommended', priority: 'high', confidence: 80, reason: 'r', recommendedAction: 'a' })
      .returning();
    await order(c.sourceId, ago(1));
    expect(await opportunities.evaluateConversions(ws.id, c.canonicalId)).toBe(0);
    expect((await opportunity(recommended.id)).status).toBe('recommended');

    const quiet = await shopper();
    const opp = await executed(quiet.canonicalId, { type: 'reorder' }, 2);
    expect(await opportunities.evaluateConversions(ws.id, quiet.canonicalId)).toBe(0);
    expect((await opportunity(opp)).status).toBe('executed');
  });

  it('another customer\'s or workspace\'s order never converts this customer\'s opportunity', async () => {
    const otherWs = await workspace();
    const x = await shopper();
    const y = await shopper();
    const z = await shopper(otherWs);
    const opp = await executed(x.canonicalId, { type: 'reorder' }, 5);
    await order(y.sourceId, ago(3));
    await order(z.sourceId, ago(3), [], { w: otherWs });

    expect(await opportunities.evaluateConversions(ws.id, x.canonicalId)).toBe(0);
    expect(await opportunities.evaluateConversions(ws.id, y.canonicalId)).toBe(0);
    expect(await opportunities.evaluateConversions(otherWs.id, z.canonicalId)).toBe(0);
    expect((await opportunity(opp)).status).toBe('executed');
  });

  it('order.created runs conversion through the existing evaluation trigger', async () => {
    const c = await shopper();
    const opp = await executed(c.canonicalId, { type: 'reorder' }, 5);
    const orderId = await order(c.sourceId, ago(1));

    await recs.handleEvaluationTrigger(createEvent({ type: 'order.created', workspaceId: ws.id, entityId: orderId, payload: { canonicalCustomerId: c.canonicalId } }));
    expect((await opportunity(opp)).status).toBe('converted');
  });

  it('detection persists the upsell target variant', async () => {
    const c = await shopper();
    const mug = await product(['10.00', '20.00']);
    await order(c.sourceId, ago(10), [mug.variantIds[0]]);
    await opportunities.detect(ws.id, c.canonicalId);
    const [upsell] = await db.client
      .select()
      .from(revenueOpportunities)
      .where(and(eq(revenueOpportunities.canonicalCustomerId, c.canonicalId), eq(revenueOpportunities.type, 'upsell')));
    expect(upsell.upsellTargetVariantId).toBe(mug.variantIds[1]);
  });
});
