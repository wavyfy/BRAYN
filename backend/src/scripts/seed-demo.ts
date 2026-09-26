import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { AppModule } from '../app.module';
import type { Env } from '../config/env.schema';
import { DatabaseService } from '../database/database.service';
import { commerceCustomers } from '../database/schema/commerce-customers';
import { WorkspaceService } from '../domains/workspace/workspace.service';
import { WorkspaceMembershipService } from '../domains/workspace/workspace-membership.service';
import { IntegrationService } from '../domains/integration/integration.service';
import { CustomerService, type NormalizedCustomer } from '../domains/commerce/customer.service';
import { ProductService, type NormalizedProduct } from '../domains/commerce/product.service';
import { OrderService, type NormalizedOrder } from '../domains/commerce/order.service';
import { IdentityResolutionService } from '../domains/identity-resolution/identity-resolution.service';
import { WebsiteTrackingKeyService } from '../domains/website-tracking/website-tracking-key.service';
import { WebsiteEventIngestService } from '../domains/website-tracking/website-event-ingest.service';
import { CustomerHealthService } from '../domains/intelligence-engines/customer-health.service';
import { RevenueOpportunityService } from '../domains/intelligence-engines/revenue-opportunity.service';
import { RecommendationService } from '../domains/intelligence-engines/recommendation.service';
import type { IntegrationProvider } from '../domains/integration/dto/connect-integration.schema';
import type { IngestWebsiteEventInput } from '../domains/website-tracking/dto/ingest-website-event.schema';

/**
 * DEVELOPMENT-ONLY demo dataset for visually reviewing the Customer
 * Intelligence View (Phase 4 — CIV demo data). Fictional store, fictional
 * customers (example.com emails), nothing here is a real person.
 *
 * Writes only through the same domain services the real pipeline uses —
 * CustomerService/IdentityResolutionService/ProductService/OrderService in
 * the same order ImportProcessorService calls them, website events through
 * WebsiteEventIngestService (write-key checked, idempotent), then the real
 * CustomerHealthService → RevenueOpportunityService → RecommendationService.
 * No health score, opportunity or recommendation row is inserted directly.
 *
 * Everything lands in its own "BRAYN Demo — Ember & Oak Coffee" workspace,
 * never an existing one, so a real (dev-store) integration is never mixed
 * with demo records. The owner of `--workspace <id>` (copy it from the
 * app URL) is granted owner access so the demo workspace shows up for them.
 *
 * Idempotent: workspace reused by name, integrations reused, commerce rows
 * upserted on externalId, website events deduped on eventId, opportunities/
 * recommendations deduped by the engines themselves. Each run does append
 * one customer_health_state_history row per customer (the real recalculate
 * path always does).
 *
 * Usage (backend/, dist built by `npm run build` or the running dev server):
 *   npm run seed:demo -- --workspace <your-workspace-id>
 */

const DEMO_WORKSPACE_NAME = 'BRAYN Demo — Ember & Oak Coffee';
const PROVIDER: IntegrationProvider = 'shopify';
const DAY_MS = 24 * 60 * 60 * 1000;

const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const products: NormalizedProduct[] = [
  {
    externalId: 'demo-prod-beans',
    title: 'Ember House Blend — Whole Bean',
    sourceUpdatedAt: daysAgo(200),
    variants: [
      { externalId: 'demo-var-beans-250', sku: 'EO-HB-250', price: '14.00', inventoryQuantity: 140, sourceUpdatedAt: daysAgo(200) },
      { externalId: 'demo-var-beans-1kg', sku: 'EO-HB-1KG', price: '38.00', inventoryQuantity: 62, sourceUpdatedAt: daysAgo(200) },
    ],
  },
  {
    externalId: 'demo-prod-pourover',
    title: 'Ceramic Pour-Over Kit',
    sourceUpdatedAt: daysAgo(200),
    variants: [
      { externalId: 'demo-var-pourover-std', sku: 'EO-PO-STD', price: '48.00', inventoryQuantity: 35, sourceUpdatedAt: daysAgo(200) },
      { externalId: 'demo-var-pourover-dlx', sku: 'EO-PO-DLX', price: '76.00', inventoryQuantity: 18, sourceUpdatedAt: daysAgo(200) },
    ],
  },
  {
    externalId: 'demo-prod-mugs',
    title: 'Stoneware Mug Set (2)',
    sourceUpdatedAt: daysAgo(200),
    variants: [{ externalId: 'demo-var-mugs', sku: 'EO-MUG-2', price: '32.00', inventoryQuantity: 50, sourceUpdatedAt: daysAgo(200) }],
  },
  {
    externalId: 'demo-prod-grinder',
    title: 'Conical Burr Grinder',
    sourceUpdatedAt: daysAgo(200),
    variants: [{ externalId: 'demo-var-grinder', sku: 'EO-GR-01', price: '129.00', inventoryQuantity: 12, sourceUpdatedAt: daysAgo(200) }],
  },
];

const priceByVariant = new Map(products.flatMap((p) => p.variants.map((v) => [v.externalId, Number(v.price)] as const)));

const customers: NormalizedCustomer[] = [
  { externalId: 'demo-cust-maya', email: 'maya.lindqvist@example.com', firstName: 'Maya', lastName: 'Lindqvist', phone: null, sourceUpdatedAt: daysAgo(9), sourceCreatedAt: daysAgo(335) },
  { externalId: 'demo-cust-daniel', email: 'daniel.okafor@example.com', firstName: 'Daniel', lastName: 'Okafor', phone: null, sourceUpdatedAt: daysAgo(150), sourceCreatedAt: daysAgo(240) },
  { externalId: 'demo-cust-priya', email: 'priya.raman@example.com', firstName: 'Priya', lastName: 'Raman', phone: null, sourceUpdatedAt: daysAgo(20), sourceCreatedAt: daysAgo(100) },
  { externalId: 'demo-cust-tomas', email: 'tomas.herrera@example.com', firstName: 'Tomás', lastName: 'Herrera', phone: null, sourceUpdatedAt: daysAgo(35), sourceCreatedAt: daysAgo(115) },
  { externalId: 'demo-cust-aiko', email: 'aiko.watanabe@example.com', firstName: 'Aiko', lastName: 'Watanabe', phone: null, sourceUpdatedAt: daysAgo(48), sourceCreatedAt: daysAgo(85) },
  { externalId: 'demo-cust-sam', email: 'sam.whitfield@example.com', firstName: 'Sam', lastName: 'Whitfield', phone: null, sourceUpdatedAt: daysAgo(62), sourceCreatedAt: daysAgo(130) },
];

/** [customerExternalId, daysAgo, [variantExternalId, quantity][]] */
const orderSpecs: [string, number, [string, number][]][] = [
  // Maya — loyal regular: 12 orders over ~11 months, bought the standard pour-over kit, never the mugs/grinder.
  ['demo-cust-maya', 330, [['demo-var-beans-1kg', 1], ['demo-var-pourover-std', 1]]],
  ['demo-cust-maya', 300, [['demo-var-beans-1kg', 1]]],
  ['demo-cust-maya', 268, [['demo-var-beans-1kg', 1]]],
  ['demo-cust-maya', 240, [['demo-var-beans-1kg', 2]]],
  ['demo-cust-maya', 205, [['demo-var-beans-1kg', 1], ['demo-var-pourover-std', 1]]],
  ['demo-cust-maya', 176, [['demo-var-beans-1kg', 1]]],
  ['demo-cust-maya', 144, [['demo-var-beans-1kg', 1]]],
  ['demo-cust-maya', 116, [['demo-var-beans-1kg', 2]]],
  ['demo-cust-maya', 88, [['demo-var-beans-1kg', 1]]],
  ['demo-cust-maya', 61, [['demo-var-beans-1kg', 1], ['demo-var-pourover-std', 1]]],
  ['demo-cust-maya', 34, [['demo-var-beans-1kg', 1]]],
  ['demo-cust-maya', 9, [['demo-var-beans-1kg', 2]]],
  // Daniel — lapsed: three small orders, last one ~5 months ago.
  ['demo-cust-daniel', 232, [['demo-var-beans-250', 2]]],
  ['demo-cust-daniel', 190, [['demo-var-beans-250', 1], ['demo-var-mugs', 1]]],
  ['demo-cust-daniel', 150, [['demo-var-beans-250', 2]]],
  // Background customers — pour-over kit + mug set bought together (workspace-wide product affinity).
  ['demo-cust-priya', 95, [['demo-var-pourover-std', 1], ['demo-var-mugs', 1]]],
  ['demo-cust-priya', 20, [['demo-var-beans-250', 2]]],
  ['demo-cust-tomas', 110, [['demo-var-pourover-std', 1], ['demo-var-mugs', 1], ['demo-var-beans-250', 1]]],
  ['demo-cust-tomas', 35, [['demo-var-grinder', 1]]],
  ['demo-cust-aiko', 80, [['demo-var-pourover-dlx', 1], ['demo-var-mugs', 1]]],
  ['demo-cust-aiko', 48, [['demo-var-beans-1kg', 1]]],
  ['demo-cust-sam', 125, [['demo-var-pourover-std', 1], ['demo-var-mugs', 1]]],
  ['demo-cust-sam', 62, [['demo-var-beans-250', 1]]],
];

const orders: NormalizedOrder[] = orderSpecs.map(([customerExternalId, age, lines], index) => {
  const externalId = `demo-order-${1001 + index}`;
  const total = lines.reduce((sum, [variant, qty]) => sum + (priceByVariant.get(variant) ?? 0) * qty, 0);
  return {
    externalId,
    customerExternalId,
    totalPrice: total.toFixed(2),
    sourceUpdatedAt: daysAgo(age),
    sourceCreatedAt: daysAgo(age),
    lineItems: lines.map(([variantExternalId, quantity], lineIndex) => ({
      externalId: `${externalId}-line-${lineIndex + 1}`,
      variantExternalId,
      quantity,
      price: priceByVariant.get(variantExternalId)!.toFixed(2),
    })),
    refunds: [],
    fulfillments: [],
  };
});

/** Maya's recent storefront browsing — linked to her by an identity_signal, exactly as the tracking snippet would. */
const mayaWebsiteEvents: [number, IngestWebsiteEventInput['eventType'], Record<string, unknown>][] = [
  [13, 'page_view', { path: '/' }],
  [13, 'identity_signal', { email: 'maya.lindqvist@example.com' }],
  [13, 'product_view', { product: 'Ceramic Pour-Over Kit — Deluxe' }],
  [11, 'search', { query: 'grinder' }],
  [11, 'product_view', { product: 'Conical Burr Grinder' }],
  [9, 'page_view', { path: '/collections/coffee' }],
  [9, 'cart', { product: 'Ember House Blend — 1kg', quantity: 2 }],
  [9, 'checkout', {}],
  [4, 'page_view', { path: '/' }],
  [4, 'product_view', { product: 'Ceramic Pour-Over Kit — Deluxe' }],
  [2, 'product_view', { product: 'Ceramic Pour-Over Kit — Deluxe' }],
  [2, 'cart', { product: 'Ceramic Pour-Over Kit — Deluxe', quantity: 1 }],
];

function parseSourceWorkspaceId(): string {
  const flag = process.argv.indexOf('--workspace');
  const value = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (!value) {
    throw new Error('Usage: npm run seed:demo -- --workspace <your-workspace-id>  (the id in /workspace/<id>/...)');
  }
  return value;
}

async function main() {
  const sourceWorkspaceId = parseSourceWorkspaceId();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    if (app.get(ConfigService<Env, true>).get('NODE_ENV', { infer: true }) === 'production') {
      throw new Error('seed:demo is development-only and refuses to run with NODE_ENV=production.');
    }

    const db = app.get(DatabaseService);
    const workspaceService = app.get(WorkspaceService);
    const membershipService = app.get(WorkspaceMembershipService);
    const integrationService = app.get(IntegrationService);

    // 1. Demo workspace, owned by the source workspace's owner.
    const owner = (await membershipService.listByWorkspace(sourceWorkspaceId)).find((m) => m.role === 'owner');
    if (!owner) {
      throw new Error(`No owner found for workspace ${sourceWorkspaceId}.`);
    }
    const existing = (await membershipService.listByUser(owner.userId)).find((w) => w.name === DEMO_WORKSPACE_NAME);
    const workspaceId = existing?.id ?? (await workspaceService.create(DEMO_WORKSPACE_NAME)).id;
    if (!existing) {
      await membershipService.addMember(workspaceId, owner.userId, 'owner');
    }

    // 2. Integrations (no provider credentials — nothing here ever calls Shopify).
    const connected = new Set((await integrationService.listByWorkspace(workspaceId)).map((i) => i.provider));
    for (const provider of [PROVIDER, 'website_tracking'] as const) {
      if (!connected.has(provider)) await integrationService.connect(workspaceId, provider);
    }
    const shopify = (await integrationService.listByWorkspace(workspaceId)).find((i) => i.provider === PROVIDER)!;

    // 3. Commerce data, in ImportProcessorService's order.
    await app.get(CustomerService).upsertMany(workspaceId, shopify.id, PROVIDER, customers);
    await app.get(IdentityResolutionService).resolveMany(workspaceId, PROVIDER, customers.map((c) => c.externalId));
    await app.get(ProductService).upsertMany(workspaceId, shopify.id, PROVIDER, products);
    const orderResult = await app.get(OrderService).upsertMany(workspaceId, shopify.id, PROVIDER, orders);

    // 4. Website behaviour through the real ingest path (write key verified, eventId-deduped).
    const { writeKey } = await app.get(WebsiteTrackingKeyService).generate(workspaceId);
    const ingest = app.get(WebsiteEventIngestService);
    let eventsAccepted = 0;
    for (const [index, [age, eventType, payload]] of mayaWebsiteEvents.entries()) {
      const result = await ingest.ingest(
        workspaceId,
        {
          visitorId: 'demo-visitor-maya',
          sessionId: `demo-session-maya-${age}`,
          eventId: `demo-event-maya-${index + 1}`,
          eventType,
          occurredAt: new Date(Date.now() - age * DAY_MS + index * 60_000).toISOString(),
          payload,
        },
        writeKey,
      );
      if (result.status === 'accepted') eventsAccepted++;
    }

    // 5. Real intelligence pipeline, per canonical customer.
    const canonicalRows = await db.client
      .select({ externalId: commerceCustomers.externalId, canonicalCustomerId: commerceCustomers.canonicalCustomerId })
      .from(commerceCustomers)
      .where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.provider, PROVIDER)));

    const health = app.get(CustomerHealthService);
    const opportunities = app.get(RevenueOpportunityService);
    const recommendations = app.get(RecommendationService);
    const summary = [];
    for (const row of canonicalRows) {
      if (!row.canonicalCustomerId) continue;
      const state = await health.recalculate(workspaceId, row.canonicalCustomerId);
      const opps = await opportunities.detect(workspaceId, row.canonicalCustomerId);
      const recs = await recommendations.generate(workspaceId, row.canonicalCustomerId);
      summary.push({
        customer: row.externalId,
        canonicalCustomerId: row.canonicalCustomerId,
        healthScore: state.score,
        opportunities: opps.map((o) => `${o.type}/${o.priority}`).join(', ') || '—',
        recommendations: recs.length,
      });
    }

    console.log(`\nDemo workspace: ${DEMO_WORKSPACE_NAME} (${workspaceId})`);
    console.log(`Orders written: ${orderResult.ordersWritten}, website events accepted this run: ${eventsAccepted}`);
    console.table(summary);
    const maya = summary.find((s) => s.customer === 'demo-cust-maya');
    if (maya) console.log(`CIV: /workspace/${workspaceId}/customers/${maya.canonicalCustomerId}`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
