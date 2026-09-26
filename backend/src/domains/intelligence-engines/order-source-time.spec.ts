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
import { IntegrationService } from '../integration/integration.service';
import { CustomerService, type NormalizedCustomer } from '../commerce/customer.service';
import { OrderService, type NormalizedOrder } from '../commerce/order.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { RevenueOpportunityService } from './revenue-opportunity.service';

/**
 * Phase 5 regression — business timing must come from when an order was
 * placed at the source, never from when BRAYN stored it. A batch import
 * writes every order in one statement, so they all share one BRAYN
 * `createdAt`; before this fix that produced ~0-day reorder gaps.
 *
 * Real DB (same approach as full-loop.spec.ts — the dev DATABASE_URL is the
 * only database this repo supports), throwaway workspace deleted in afterAll.
 */
describe('Order source time — batch import (real DB)', () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let customerIntelligence: CustomerIntelligenceService;
  let opportunities: RevenueOpportunityService;
  let orderService: OrderService;
  let integrationId: string;

  const workspaceId = randomUUID();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const daysAgo = (days: number) => new Date(now - days * DAY_MS);

  const customers: NormalizedCustomer[] = [
    // Regular buyer: every 30 days, last one 35 days ago → due for a reorder.
    { externalId: 'due', email: `due-${workspaceId}@example.com`, firstName: 'Due', lastName: null, phone: null, sourceUpdatedAt: daysAgo(1), sourceCreatedAt: daysAgo(120) },
    // Bought 20/10/2 days ago → NOT due. Pre-fix, identical import times made this look due.
    { externalId: 'recent', email: `recent-${workspaceId}@example.com`, firstName: 'Recent', lastName: null, phone: null, sourceUpdatedAt: daysAgo(1), sourceCreatedAt: null },
    // Imported before source_created_at existed.
    { externalId: 'legacy', email: `legacy-${workspaceId}@example.com`, firstName: 'Legacy', lastName: null, phone: null, sourceUpdatedAt: daysAgo(1), sourceCreatedAt: null },
  ];

  const order = (externalId: string, customerExternalId: string, placedDaysAgo: number): NormalizedOrder => ({
    externalId,
    customerExternalId,
    totalPrice: '40.00',
    // Every order was just modified (e.g. fulfilled/edited) at the source — must not be read as placement time either.
    sourceUpdatedAt: daysAgo(0),
    sourceCreatedAt: daysAgo(placedDaysAgo),
    lineItems: [],
    refunds: [],
    fulfillments: [],
  });

  // Deliberately not in chronological order — the batch order must not matter.
  const batch: NormalizedOrder[] = [
    order('due-2', 'due', 65),
    order('recent-1', 'recent', 20),
    order('due-3', 'due', 35),
    order('recent-3', 'recent', 2),
    order('due-1', 'due', 95),
    order('recent-2', 'recent', 10),
    // Legacy row: no source placement time recorded, only the provider's last-modified time.
    { ...order('legacy-1', 'legacy', 0), sourceCreatedAt: null, sourceUpdatedAt: daysAgo(50) },
  ];

  async function canonicalIdFor(externalId: string): Promise<string> {
    const rows = await db.client.select().from(commerceCustomers).where(eq(commerceCustomers.workspaceId, workspaceId));
    return rows.find((row) => row.externalId === externalId)!.canonicalCustomerId!;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    customerIntelligence = moduleRef.get(CustomerIntelligenceService);
    opportunities = moduleRef.get(RevenueOpportunityService);
    orderService = moduleRef.get(OrderService);

    await db.client.insert(workspaces).values({ id: workspaceId, name: 'Order Source Time Test Workspace' });
    integrationId = (await moduleRef.get(IntegrationService).connect(workspaceId, 'shopify')).id;

    await moduleRef.get(CustomerService).upsertMany(workspaceId, integrationId, 'shopify', customers);
    await moduleRef.get(IdentityResolutionService).resolveMany(workspaceId, 'shopify', customers.map((c) => c.externalId));
    await orderService.upsertMany(workspaceId, integrationId, 'shopify', batch);
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    await db.client.delete(revenueOpportunities).where(eq(revenueOpportunities.workspaceId, workspaceId));
    await db.client.delete(commerceOrders).where(eq(commerceOrders.workspaceId, workspaceId));
    await db.client.delete(commerceCustomers).where(eq(commerceCustomers.workspaceId, workspaceId));
    await db.client.delete(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, workspaceId));
    await db.client.delete(integrations).where(eq(integrations.workspaceId, workspaceId));
    await db.client.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await moduleRef.close();
  });

  it('stores the source placement time, while every batch-imported row shares one BRAYN createdAt', async () => {
    const rows = await db.client.select().from(commerceOrders).where(eq(commerceOrders.workspaceId, workspaceId));

    expect(new Set(rows.map((row) => row.createdAt.getTime())).size).toBe(1);
    expect(rows.find((row) => row.externalId === 'due-1')!.sourceCreatedAt).toEqual(daysAgo(95));
  });

  it('builds the commerce context from source placement time', async () => {
    const customer = await customerIntelligence.getCustomer(workspaceId, await canonicalIdFor('due'));

    expect(customer.commerceContext.lastOrderAt).toEqual(daysAgo(35));
    expect(customer.commerceContext.ordersLast90Days).toBe(2);
    expect(customer.commerceContext.recentOrders.map((o) => o.externalId)).toEqual(['due-3', 'due-2', 'due-1']);
  });

  it('falls back to the provider\'s last-modified time for a legacy order with no source placement time', async () => {
    const customer = await customerIntelligence.getCustomer(workspaceId, await canonicalIdFor('legacy'));

    expect(customer.commerceContext.lastOrderAt).toEqual(daysAgo(50));
  });

  it('detects a reorder from the real ~30-day source cadence, not ~0-day import gaps', async () => {
    const detected = await opportunities.detect(workspaceId, await canonicalIdFor('due'));
    const reorder = detected.find((o) => o.type === 'reorder');

    expect(reorder?.reason).toBe('Customer typically reorders every ~30 day(s); 35 day(s) have passed since their last order.');
  });

  it('does not flag a reorder for a customer whose source cadence says they are not due', async () => {
    const detected = await opportunities.detect(workspaceId, await canonicalIdFor('recent'));

    expect(detected.find((o) => o.type === 'reorder')).toBeUndefined();
  });

  it('keeps source time stable and creates no duplicate across a repeated import', async () => {
    await orderService.upsertMany(workspaceId, integrationId, 'shopify', batch);
    const detected = await opportunities.detect(workspaceId, await canonicalIdFor('due'));

    expect(detected.filter((o) => o.type === 'reorder')).toHaveLength(1);
    const rows = await db.client.select().from(commerceOrders).where(eq(commerceOrders.workspaceId, workspaceId));
    expect(rows.find((row) => row.externalId === 'due-3')!.sourceCreatedAt).toEqual(daysAgo(35));
  });

  it('orders the activity timeline by source time and never times a customer entry by import time', async () => {
    const due = await customerIntelligence.getActivity(workspaceId, await canonicalIdFor('due'));
    expect(due.map((entry) => entry.type)).toEqual(['order_placed', 'order_placed', 'order_placed', 'customer_created']);
    expect(due[3].occurredAt).toEqual(daysAgo(120));

    // No source "added to store" time → no customer_created entry at all (not one stamped with the import time).
    const recent = await customerIntelligence.getActivity(workspaceId, await canonicalIdFor('recent'));
    expect(recent.map((entry) => entry.type)).toEqual(['order_placed', 'order_placed', 'order_placed']);
    expect(recent[0].occurredAt).toEqual(daysAgo(2));
  });
});
