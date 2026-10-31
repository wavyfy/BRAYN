import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { integrations } from '../../database/schema/integrations';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { customerHealthStates } from '../../database/schema/customer-health-states';
import { customerHealthStateHistory } from '../../database/schema/customer-health-state-history';
import { IntegrationService } from '../integration/integration.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';
import { CustomerService, type NormalizedCustomer } from '../commerce/customer.service';
import { OrderService, type NormalizedOrder } from '../commerce/order.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { CustomerHealthService } from './customer-health.service';
import { RevenueOpportunityService } from './revenue-opportunity.service';

/**
 * Provider independence of the core (Identity Resolution → UCIR → Customer
 * Risk & Engagement State → Revenue Opportunity Detector): every core layer
 * consumes normalized commerce records keyed by the canonical customer, so
 * the same customer signals must produce the same intelligence whichever
 * provider supplied them, and one person's records from two providers must
 * unify into one customer. Provider/externalId survive only as source
 * metadata (doc09 Source Identity Mapping).
 *
 * Real DB (same approach as order-source-time.spec.ts), throwaway workspace
 * deleted in afterAll. Synthetic normalized records — no provider adapter.
 */
describe('Provider parity — core intelligence (real DB)', () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let customerIntelligence: CustomerIntelligenceService;
  let health: CustomerHealthService;
  let opportunities: RevenueOpportunityService;

  const workspaceId = randomUUID();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const daysAgo = (days: number) => new Date(now - days * DAY_MS);
  const integrationIds = {} as Record<IntegrationProvider, string>;
  const newOrderIds = {} as Record<string, string[]>;

  const customer = (externalId: string, email: string): NormalizedCustomer => ({
    externalId,
    email,
    firstName: 'Twin',
    lastName: null,
    phone: null,
    sourceUpdatedAt: daysAgo(1),
    sourceCreatedAt: daysAgo(200),
  });

  const order = (externalId: string, customerExternalId: string, placedDaysAgo: number): NormalizedOrder => ({
    externalId,
    customerExternalId,
    totalPrice: '40.00',
    sourceUpdatedAt: daysAgo(placedDaysAgo),
    sourceCreatedAt: daysAgo(placedDaysAgo),
    lineItems: [],
    refunds: [],
    fulfillments: [],
  });

  // Identical history (every ~30 days, last one 35 days ago) for a Shopify-only and a WooCommerce-only customer.
  const twinHistory = [95, 65, 35];

  async function ingest(provider: IntegrationProvider, customers: NormalizedCustomer[], orders: NormalizedOrder[]) {
    await moduleRef.get(CustomerService).upsertMany(workspaceId, integrationIds[provider], provider, customers);
    await moduleRef.get(IdentityResolutionService).resolveMany(workspaceId, provider, customers.map((c) => c.externalId));
    const { newOrderCanonicalCustomerIds } = await moduleRef.get(OrderService).upsertMany(workspaceId, integrationIds[provider], provider, orders);
    newOrderIds[provider] = newOrderCanonicalCustomerIds;
  }

  async function canonicalIdFor(provider: IntegrationProvider, externalId: string): Promise<string> {
    const rows = await db.client.select().from(commerceCustomers).where(eq(commerceCustomers.workspaceId, workspaceId));
    return rows.find((row) => row.provider === provider && row.externalId === externalId)!.canonicalCustomerId!;
  }

  /** Strips source metadata so two providers' outputs can be compared field-for-field. */
  function withoutSource(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(withoutSource);
    if (value instanceof Date || value === null || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['provider', 'externalId', 'canonicalCustomerId', 'id', 'sourceCustomers', 'profile'].includes(key))
        .map(([key, inner]) => [key, withoutSource(inner)]),
    );
  }

  const opportunitySummary = (rows: { type: string; priority: string; reason: string; confidence: number; estimatedRevenue: string | null }[]) =>
    rows.map(({ type, priority, reason, confidence, estimatedRevenue }) => ({ type, priority, reason, confidence, estimatedRevenue }));

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    customerIntelligence = moduleRef.get(CustomerIntelligenceService);
    health = moduleRef.get(CustomerHealthService);
    opportunities = moduleRef.get(RevenueOpportunityService);

    await db.client.insert(workspaces).values({ id: workspaceId, name: 'Provider Parity Test Workspace' });
    for (const provider of ['shopify', 'woocommerce'] as const) {
      integrationIds[provider] = (await moduleRef.get(IntegrationService).connect(workspaceId, provider)).id;
    }

    // Same person on both stores: email differs only by case/whitespace; orders split across providers.
    const sharedEmail = `shared-${workspaceId}@example.com`;
    await ingest(
      'shopify',
      [customer('s-twin', `s-twin-${workspaceId}@example.com`), customer('s-shared', sharedEmail)],
      [...twinHistory.map((d, i) => order(`s-twin-${i}`, 's-twin', d)), order('s-shared-1', 's-shared', 70)],
    );
    await ingest(
      'woocommerce',
      [customer('w-twin', `w-twin-${workspaceId}@example.com`), customer('w-shared', `  ${sharedEmail.toUpperCase()} `)],
      [...twinHistory.map((d, i) => order(`w-twin-${i}`, 'w-twin', d)), order('w-shared-1', 'w-shared', 40)],
    );
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    // Automatic evaluation (Milestone #5) creates recommendations, which reference opportunities.
    await db.client.delete(recommendations).where(eq(recommendations.workspaceId, workspaceId));
    await db.client.delete(revenueOpportunities).where(eq(revenueOpportunities.workspaceId, workspaceId));
    await db.client.delete(customerHealthStateHistory).where(eq(customerHealthStateHistory.workspaceId, workspaceId));
    await db.client.delete(customerHealthStates).where(eq(customerHealthStates.workspaceId, workspaceId));
    await db.client.delete(commerceOrders).where(eq(commerceOrders.workspaceId, workspaceId));
    await db.client.delete(commerceCustomers).where(eq(commerceCustomers.workspaceId, workspaceId));
    await db.client.delete(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, workspaceId));
    await db.client.delete(integrations).where(eq(integrations.workspaceId, workspaceId));
    await db.client.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await moduleRef.close();
  });

  it('builds the same UCIR commerce context and activity for identical Shopify and WooCommerce signals', async () => {
    const shopifyId = await canonicalIdFor('shopify', 's-twin');
    const wooId = await canonicalIdFor('woocommerce', 'w-twin');

    const [shopify, woo] = await Promise.all([
      customerIntelligence.getCustomer(workspaceId, shopifyId),
      customerIntelligence.getCustomer(workspaceId, wooId),
    ]);
    expect(shopify.commerceContext.ordersCount).toBe(3);
    expect(withoutSource(woo.commerceContext)).toEqual(withoutSource(shopify.commerceContext));

    const [shopifyActivity, wooActivity] = await Promise.all([
      customerIntelligence.getActivity(workspaceId, shopifyId),
      customerIntelligence.getActivity(workspaceId, wooId),
    ]);
    expect(withoutSource(wooActivity)).toEqual(withoutSource(shopifyActivity));
  });

  it('computes the same Customer Risk & Engagement State regardless of provider', async () => {
    const [shopify, woo] = await Promise.all([
      health.recalculate(workspaceId, await canonicalIdFor('shopify', 's-twin')),
      health.recalculate(workspaceId, await canonicalIdFor('woocommerce', 'w-twin')),
    ]);

    expect({ ...woo, canonicalCustomerId: undefined, lastCalculatedAt: undefined }).toEqual({
      ...shopify,
      canonicalCustomerId: undefined,
      lastCalculatedAt: undefined,
    });
  });

  it('detects the same revenue opportunities regardless of provider', async () => {
    const shopify = await opportunities.detect(workspaceId, await canonicalIdFor('shopify', 's-twin'));
    const woo = await opportunities.detect(workspaceId, await canonicalIdFor('woocommerce', 'w-twin'));

    expect(shopify.map((o) => o.type)).toContain('reorder');
    expect(opportunitySummary(woo)).toEqual(opportunitySummary(shopify));
  }, 30_000);

  it('reports newly created orders for downstream order.created identically for both providers', () => {
    expect(newOrderIds.shopify).toHaveLength(2);
    expect(newOrderIds.woocommerce).toHaveLength(2);
  });

  it('unifies one person across providers into a single canonical customer with merged history', async () => {
    const shopifyId = await canonicalIdFor('shopify', 's-shared');
    const wooId = await canonicalIdFor('woocommerce', 'w-shared');
    expect(wooId).toBe(shopifyId);

    const record = await customerIntelligence.getCustomer(workspaceId, shopifyId);
    expect(record.sourceCustomers.map((s) => s.provider).sort()).toEqual(['shopify', 'woocommerce']);
    expect(record.commerceContext.ordersCount).toBe(2);
    expect(record.commerceContext.lastOrderAt).toEqual(daysAgo(40));

    const activity = await customerIntelligence.getActivity(workspaceId, shopifyId);
    const orders = activity.filter((entry) => entry.type === 'order_placed');
    expect(orders.map((entry) => ('provider' in entry ? entry.provider : null))).toEqual(['woocommerce', 'shopify']);
  });
});
