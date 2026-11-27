import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { integrations } from '../../database/schema/integrations';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { commerceOrderLineItems } from '../../database/schema/commerce-order-line-items';
import { commerceRefunds } from '../../database/schema/commerce-refunds';
import { commerceRefundLineItems } from '../../database/schema/commerce-refund-line-items';
import { commerceFulfillments } from '../../database/schema/commerce-fulfillments';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { customerHealthStates } from '../../database/schema/customer-health-states';
import { customerHealthStateHistory } from '../../database/schema/customer-health-state-history';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { EventBus } from '../../common/events/event-bus.service';
import type { DomainEvent } from '../../common/events/domain-event';
import { IntegrationService } from '../integration/integration.service';
import { WebhookIngestService } from '../integration/webhook-ingest.service';
import { WebhookEventProcessorService } from '../integration/webhook-event-processor.service';
import { WooCommerceAdapter } from '../integration/providers/woocommerce/woocommerce.adapter';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { CustomerService } from './customer.service';
import { OrderService, type NormalizedOrder } from './order.service';
import type { OrderEventPayload, RefundProcessedPayload } from './commerce-events';

const COMMERCE_EVENT_TYPES = ['order.created', 'order.updated', 'order.cancelled', 'refund.processed'];

/**
 * Commerce domain events end to end against the real dev DB: signed Shopify
 * webhook deliveries → durable ingest → processor → OrderService (the
 * producer) → EventBus. Duplicate/out-of-order/concurrent delivery and the
 * row-lock that dedupes them are Postgres behavior, so they're proven here
 * rather than with mocks. Throwaway workspace deleted in afterAll.
 */
// Every step is a real Neon round trip (~250ms each), so the default 5s per-test budget is too tight.
describe('Commerce domain events (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let ingest: WebhookIngestService;
  let processor: WebhookEventProcessorService;
  let eventBus: EventBus;
  let emitted: DomainEvent[] = [];

  const workspaceId = randomUUID();
  // The store this workspace's Shopify integration holds: business webhooks for any other shop are quarantined.
  const shopDomain = `brayn-commerce-events-${randomUUID().slice(0, 8)}.myshopify.com`;
  const webhookSecret = 'commerce-events-test-secret';
  const customerExternalId = '7001';
  const integrationIds: Record<string, string> = {};
  let canonicalCustomerId: string;

  const commerceEvents = () => emitted.filter((event) => COMMERCE_EVENT_TYPES.includes(event.type));
  const ofType = (type: string) => commerceEvents().filter((event) => event.type === type) as DomainEvent<OrderEventPayload>[];

  interface ShopifyOrderPayload {
    id: number;
    updatedAt: string;
    totalPrice?: string;
    cancelledAt?: string | null;
    refunds?: unknown[];
    fulfillments?: unknown[];
  }

  /** A REST-shaped Shopify order webhook body, the shape `orders/create`/`orders/updated` deliver. */
  function orderBody(order: ShopifyOrderPayload) {
    return JSON.stringify({
      id: order.id,
      customer: { id: Number(customerExternalId) },
      total_price: order.totalPrice ?? '50.00',
      created_at: '2026-03-01T10:00:00Z',
      updated_at: order.updatedAt,
      cancelled_at: order.cancelledAt ?? null,
      line_items: [{ id: order.id * 10, variant_id: null, quantity: 1, price: '50.00' }],
      refunds: order.refunds ?? [],
      fulfillments: order.fulfillments ?? [],
    });
  }

  function signed(topic: string, body: string, webhookId: string = randomUUID()) {
    return {
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': shopDomain,
      'x-shopify-hmac-sha256': createHmac('sha256', webhookSecret).update(body, 'utf8').digest('base64'),
      'x-shopify-webhook-id': webhookId,
    };
  }

  /** Ingests one signed delivery (each with its own Shopify webhook id) and processes it synchronously — no reliance on the async wake-up. */
  async function deliver(topic: 'orders/create' | 'orders/updated', order: ShopifyOrderPayload) {
    const body = orderBody(order);
    const result = await ingestWithoutWake(body, signed(topic, body));
    await processor.processEvent(result);
    return result;
  }

  /** A standalone Shopify `refunds/create` body: the bare refund plus `order_id`. */
  function refundBody(refundId: number, orderId: number) {
    return JSON.stringify({ ...refund(refundId, orderId * 10), order_id: orderId });
  }

  async function deliverRefund(refundId: number, orderId: number, webhookId?: string) {
    const body = refundBody(refundId, orderId);
    const result = await ingestWithoutWake(body, signed('refunds/create', body, webhookId));
    await processor.processEvent(result);
    return result;
  }

  /** Ingest with the wake-up dropped, so the test processes the row itself. Dropped by event type, not call order — a still-running health handler from a previous step may emit concurrently. */
  let suppressWake = false;
  async function ingestWithoutWake(body: string, headers: Record<string, string>, provider: 'shopify' | 'woocommerce' = 'shopify'): Promise<string> {
    suppressWake = true;
    try {
      const result = await ingest.ingest(workspaceId, provider, body, headers);
      if (result.status !== 'accepted') throw new Error(`expected accepted, got ${result.status}`);
      return result.webhookEventId;
    } finally {
      suppressWake = false;
    }
  }

  function captureEmits() {
    const original = EventBus.prototype.emit;
    vi.spyOn(eventBus, 'emit').mockImplementation(function (this: EventBus, event) {
      if (suppressWake && event.type === 'integration.webhook.received') return;
      emitted.push(event as DomainEvent);
      return original.call(this, event);
    });
  }

  async function storedOrder(externalId: number) {
    const [row] = await db.client
      .select()
      .from(commerceOrders)
      .where(and(eq(commerceOrders.workspaceId, workspaceId), eq(commerceOrders.externalId, String(externalId))));
    return row;
  }

  async function healthHistoryCount() {
    const [row] = await db.client
      .select({ count: sql<number>`count(*)::int` })
      .from(customerHealthStateHistory)
      .where(eq(customerHealthStateHistory.workspaceId, workspaceId));
    return row.count;
  }

  /** The health handler runs fire-and-forget off the emit — poll the DB rather than sleep. */
  async function waitForHealthHistory(atLeast: number) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const count = await healthHistoryCount();
      if (count >= atLeast) return count;
      if (Date.now() > deadline) throw new Error(`health history stayed at ${count}, expected ≥ ${atLeast}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const refund = (id: number, lineItemId: number) => ({
    id,
    note: null,
    processed_at: '2026-03-05T12:00:00Z',
    refund_line_items: [{ id: id * 10, line_item_id: lineItemId, quantity: 1 }],
    transactions: [{ amount: '50.00', status: 'success' }],
  });

  const fulfillment = (id: number, orderId: number, updatedAt: string, status = 'success') => ({
    id,
    order_id: orderId,
    status,
    tracking_company: 'UPS',
    tracking_number: '1Z999',
    tracking_url: null,
    shipment_status: 'in_transit',
    updated_at: updatedAt,
  });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    ingest = moduleRef.get(WebhookIngestService);
    processor = moduleRef.get(WebhookEventProcessorService);
    eventBus = moduleRef.get(EventBus);

    await db.client.insert(workspaces).values({ id: workspaceId, name: 'Commerce Events Test Workspace' });
    const integrationService = moduleRef.get(IntegrationService);
    for (const provider of ['shopify', 'woocommerce'] as const) {
      integrationIds[provider] = (await integrationService.connect(workspaceId, provider)).id;
    }
    await integrationService.setCredentials(workspaceId, 'shopify', {
      shopDomain,
      accessToken: 'unused-in-this-test',
      webhookSecret,
    });
    await integrationService.setCredentials(workspaceId, 'woocommerce', {
      storeUrl: 'https://brayn-commerce-events-test.example.com',
      consumerKey: 'unused-in-this-test',
      consumerSecret: 'unused-in-this-test',
      webhookSecret,
    });

    const customer = {
      externalId: customerExternalId,
      email: `events-${workspaceId}@example.com`,
      firstName: 'Event',
      lastName: null,
      phone: null,
      sourceUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      sourceCreatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    await moduleRef.get(CustomerService).upsertMany(workspaceId, integrationIds.shopify, 'shopify', [customer]);
    await moduleRef.get(CustomerService).upsertMany(workspaceId, integrationIds.woocommerce, 'woocommerce', [customer]);
    await moduleRef.get(IdentityResolutionService).resolveMany(workspaceId, 'shopify', [customerExternalId]);
    await moduleRef.get(IdentityResolutionService).resolveMany(workspaceId, 'woocommerce', [customerExternalId]);
    const [row] = await db.client
      .select({ canonicalCustomerId: commerceCustomers.canonicalCustomerId })
      .from(commerceCustomers)
      .where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.provider, 'shopify')));
    canonicalCustomerId = row.canonicalCustomerId!;

    captureEmits();
  }, 90_000);

  beforeEach(() => {
    emitted = [];
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (db?.isConfigured()) {
      // Event handlers are fire-and-forget (health recalculation → automatic evaluation); let in-flight ones
      // finish writing before teardown, or they insert rows that reference already-deleted customers.
      const writtenCount = async () => {
        let total = 0;
        for (const table of [customerHealthStateHistory, revenueOpportunities, recommendations]) {
          total += Number((await db.client.select({ n: sql<number>`count(*)` }).from(table).where(eq(table.workspaceId, workspaceId)))[0].n);
        }
        return total;
      };
      for (let previous = -1, current = await writtenCount(), i = 0; current !== previous && i < 15; i++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        [previous, current] = [current, await writtenCount()];
      }
      const orderIds = (await db.client.select({ id: commerceOrders.id }).from(commerceOrders).where(eq(commerceOrders.workspaceId, workspaceId))).map((r) => r.id);
      // Automatic evaluation (Milestone #5) creates recommendations, which reference opportunities.
      await db.client.delete(recommendations).where(eq(recommendations.workspaceId, workspaceId));
      await db.client.delete(revenueOpportunities).where(eq(revenueOpportunities.workspaceId, workspaceId));
      await db.client.delete(customerHealthStateHistory).where(eq(customerHealthStateHistory.workspaceId, workspaceId));
      await db.client.delete(customerHealthStates).where(eq(customerHealthStates.workspaceId, workspaceId));
      await db.client.delete(commerceRefundLineItems).where(eq(commerceRefundLineItems.workspaceId, workspaceId));
      await db.client.delete(commerceRefunds).where(eq(commerceRefunds.workspaceId, workspaceId));
      await db.client.delete(commerceFulfillments).where(eq(commerceFulfillments.workspaceId, workspaceId));
      if (orderIds.length > 0) await db.client.delete(commerceOrderLineItems).where(inArray(commerceOrderLineItems.orderId, orderIds));
      await db.client.delete(commerceOrders).where(eq(commerceOrders.workspaceId, workspaceId));
      await db.client.delete(commerceCustomers).where(eq(commerceCustomers.workspaceId, workspaceId));
      await db.client.delete(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, workspaceId));
      await db.client.delete(integrationWebhookEvents).where(eq(integrationWebhookEvents.workspaceId, workspaceId));
      await db.client.delete(integrations).where(eq(integrations.workspaceId, workspaceId));
      await db.client.delete(workspaces).where(eq(workspaces.id, workspaceId));
    }
    await moduleRef?.close();
  }, 90_000);

  it('emits order.created exactly once for a new order, with workspace/order/customer/source-time in the contract', async () => {
    await deliver('orders/create', { id: 100, updatedAt: '2026-03-01T10:00:00Z' });

    const created = ofType('order.created');
    expect(commerceEvents()).toHaveLength(1);
    const order = await storedOrder(100);
    expect(created[0]).toMatchObject({
      type: 'order.created',
      version: 1,
      workspaceId,
      entityId: order.id,
      idempotencyKey: `order.created:${order.id}`,
      payload: {
        orderId: order.id,
        orderExternalId: '100',
        provider: 'shopify',
        canonicalCustomerId,
        sourceOccurredAt: '2026-03-01T10:00:00.000Z',
      },
    });
  });

  it('keeps order.created driving health recalculation (existing behavior unchanged)', async () => {
    const before = await healthHistoryCount();
    await deliver('orders/create', { id: 101, updatedAt: '2026-03-01T10:00:00Z' });

    expect(ofType('order.created')).toHaveLength(1);
    await waitForHealthHistory(before + 1);
  });

  it('emits no event for a duplicate delivery of the same order version (orders/create then orders/updated, same payload)', async () => {
    await deliver('orders/updated', { id: 100, updatedAt: '2026-03-01T10:00:00Z' });
    await deliver('orders/updated', { id: 100, updatedAt: '2026-03-01T10:00:00Z' });

    expect(commerceEvents()).toEqual([]);
  });

  it('emits order.updated exactly once for a newer version, and not again on redelivery', async () => {
    await deliver('orders/updated', { id: 100, updatedAt: '2026-03-02T10:00:00Z', totalPrice: '55.00' });
    await deliver('orders/updated', { id: 100, updatedAt: '2026-03-02T10:00:00Z', totalPrice: '55.00' });

    const updated = ofType('order.updated');
    expect(commerceEvents()).toHaveLength(1);
    expect(updated[0].payload).toMatchObject({ orderExternalId: '100', canonicalCustomerId, sourceOccurredAt: '2026-03-02T10:00:00.000Z' });
    expect(updated[0].idempotencyKey).toBe(`order.updated:${updated[0].entityId}:2026-03-02T10:00:00.000Z`);
  });

  it('ignores an out-of-order older delivery: no event, newer commerce state kept', async () => {
    await deliver('orders/updated', { id: 100, updatedAt: '2026-03-01T12:00:00Z', totalPrice: '1.00' });

    expect(commerceEvents()).toEqual([]);
    const order = await storedOrder(100);
    expect(order.totalPrice).toBe('55.00');
    expect(order.sourceUpdatedAt).toEqual(new Date('2026-03-02T10:00:00Z'));
  });

  it('emits exactly one order.updated when two deliveries of the same newer version are processed concurrently', async () => {
    const order = { id: 100, updatedAt: '2026-03-03T10:00:00Z', totalPrice: '56.00' };
    const body = orderBody(order);
    const sign = () => ({
      'x-shopify-topic': 'orders/updated',
      'x-shopify-shop-domain': shopDomain,
      'x-shopify-hmac-sha256': createHmac('sha256', webhookSecret).update(body, 'utf8').digest('base64'),
      'x-shopify-webhook-id': randomUUID(),
    });
    const first = await ingestWithoutWake(body, sign());
    const second = await ingestWithoutWake(body, sign());

    await Promise.all([processor.processEvent(first), processor.processEvent(second)]);

    expect(ofType('order.updated')).toHaveLength(1);
  });

  it('emits refund.processed exactly once for a new refund, triggers health recalculation, and lands in activity history', async () => {
    const before = await healthHistoryCount();
    const withRefund = { id: 100, updatedAt: '2026-03-05T12:00:00Z', refunds: [refund(5001, 1000)] };

    await deliver('orders/updated', withRefund);
    await deliver('orders/updated', withRefund);

    const refunds = ofType('refund.processed') as DomainEvent<RefundProcessedPayload>[];
    expect(refunds).toHaveLength(1);
    expect(refunds[0].payload).toMatchObject({
      orderExternalId: '100',
      refundExternalId: '5001',
      totalRefunded: '50.00',
      provider: 'shopify',
      canonicalCustomerId,
      sourceOccurredAt: '2026-03-05T12:00:00.000Z',
    });
    expect(refunds[0].entityId).toBe(refunds[0].payload.refundId);
    expect(ofType('order.updated')).toHaveLength(1);
    await waitForHealthHistory(before + 1);

    const activity = await moduleRef.get(CustomerIntelligenceService).getActivity(workspaceId, canonicalCustomerId);
    expect(activity).toContainEqual(
      expect.objectContaining({ type: 'refund_processed', externalId: '5001', orderExternalId: '100', occurredAt: new Date('2026-03-05T12:00:00Z') }),
    );
  });

  it('stores fulfillments (no fulfillment domain event — doc21 defines none) and shows them in activity history', async () => {
    await deliver('orders/updated', { id: 101, updatedAt: '2026-03-06T09:00:00Z', fulfillments: [fulfillment(6001, 101, '2026-03-06T09:00:00Z')] });

    expect(commerceEvents().map((event) => event.type)).toEqual(['order.updated']);
    const activity = await moduleRef.get(CustomerIntelligenceService).getActivity(workspaceId, canonicalCustomerId);
    expect(activity).toContainEqual(
      expect.objectContaining({ type: 'fulfillment', externalId: '6001', orderExternalId: '101', shipmentStatus: 'in_transit', occurredAt: new Date('2026-03-06T09:00:00Z') }),
    );
  });

  it('never lets an older fulfillment delivery overwrite a newer fulfillment state', async () => {
    const orderService = moduleRef.get(OrderService);
    const older = { externalId: '6001', orderExternalId: '101', status: 'failure', trackingCompany: null, trackingNumber: null, trackingUrl: null, shipmentStatus: 'failure', sourceUpdatedAt: new Date('2026-03-06T08:00:00Z') };

    await orderService.upsertFulfillments(workspaceId, integrationIds.shopify, 'shopify', [older]);

    const [row] = await db.client
      .select()
      .from(commerceFulfillments)
      .where(and(eq(commerceFulfillments.workspaceId, workspaceId), eq(commerceFulfillments.externalId, '6001')));
    expect(row.status).toBe('success');
    expect(row.shipmentStatus).toBe('in_transit');
  });

  it('emits order.cancelled exactly once when the order becomes cancelled, triggers health recalculation, and lands in activity history', async () => {
    const before = await healthHistoryCount();
    const cancelled = { id: 101, updatedAt: '2026-03-07T09:00:00Z', cancelledAt: '2026-03-07T09:00:00Z', fulfillments: [fulfillment(6001, 101, '2026-03-06T09:00:00Z')] };

    await deliver('orders/updated', cancelled);
    await deliver('orders/updated', { ...cancelled, updatedAt: '2026-03-08T09:00:00Z' });

    expect(ofType('order.cancelled')).toHaveLength(1);
    expect(ofType('order.cancelled')[0].payload).toMatchObject({ orderExternalId: '101', canonicalCustomerId, sourceOccurredAt: '2026-03-07T09:00:00.000Z' });
    expect(ofType('order.updated')).toHaveLength(2);
    await waitForHealthHistory(before + 1);

    const activity = await moduleRef.get(CustomerIntelligenceService).getActivity(workspaceId, canonicalCustomerId);
    expect(activity).toContainEqual(expect.objectContaining({ type: 'order_cancelled', externalId: '101', occurredAt: new Date('2026-03-07T09:00:00Z') }));
  });

  it('A: a standalone refunds/create delivery persists the refund, emits refund.processed once, recalculates health and lands in activity', async () => {
    const before = await healthHistoryCount();

    await deliverRefund(5101, 100);

    const refunds = ofType('refund.processed') as DomainEvent<RefundProcessedPayload>[];
    expect(commerceEvents()).toHaveLength(1);
    expect(refunds[0].payload).toMatchObject({
      orderExternalId: '100',
      refundExternalId: '5101',
      totalRefunded: '50.00',
      provider: 'shopify',
      canonicalCustomerId,
      sourceOccurredAt: '2026-03-05T12:00:00.000Z',
    });
    const [row] = await db.client.select().from(commerceRefunds).where(and(eq(commerceRefunds.workspaceId, workspaceId), eq(commerceRefunds.externalId, '5101')));
    expect(row).toMatchObject({ totalRefunded: '50.00', processedAt: new Date('2026-03-05T12:00:00Z') });
    const [lineItem] = await db.client.select().from(commerceRefundLineItems).where(eq(commerceRefundLineItems.refundId, row.id));
    expect(lineItem.orderLineItemId).not.toBeNull();
    await waitForHealthHistory(before + 1);
    const activity = await moduleRef.get(CustomerIntelligenceService).getActivity(workspaceId, canonicalCustomerId);
    expect(activity).toContainEqual(expect.objectContaining({ type: 'refund_processed', externalId: '5101', orderExternalId: '100' }));
  });

  it('B: a duplicate refunds/create — redelivered (same webhook id) or re-sent (new webhook id) — emits nothing more', async () => {
    const body = refundBody(5101, 100);
    const webhookId = randomUUID();
    await deliverRefund(5101, 100, webhookId);

    expect(await ingest.ingest(workspaceId, 'shopify', body, signed('refunds/create', body, webhookId))).toEqual({ status: 'duplicate' });
    await deliverRefund(5101, 100);

    expect(commerceEvents()).toEqual([]);
  });

  it('C: refunds/create then orders/updated carrying the same refund — and the reverse — each yields exactly one refund.processed', async () => {
    await deliver('orders/updated', { id: 100, updatedAt: '2026-03-09T10:00:00Z', refunds: [refund(5001, 1000), refund(5101, 1000)] });
    expect(ofType('refund.processed')).toEqual([]);
    expect(ofType('order.updated')).toHaveLength(1);

    emitted = [];
    await deliver('orders/updated', { id: 100, updatedAt: '2026-03-10T10:00:00Z', refunds: [refund(5001, 1000), refund(5101, 1000), refund(5102, 1000)] });
    await deliverRefund(5102, 100);
    expect(ofType('refund.processed').map((event) => (event.payload as unknown as RefundProcessedPayload).refundExternalId)).toEqual(['5102']);
  });

  it('E: two concurrent deliveries of the same new refund emit exactly one refund.processed', async () => {
    const body = refundBody(5103, 100);
    const first = await ingestWithoutWake(body, signed('refunds/create', body));
    const second = await ingestWithoutWake(body, signed('refunds/create', body));

    await Promise.all([processor.processEvent(first), processor.processEvent(second)]);

    expect(ofType('refund.processed')).toHaveLength(1);
    const rows = await db.client.select().from(commerceRefunds).where(and(eq(commerceRefunds.workspaceId, workspaceId), eq(commerceRefunds.externalId, '5103')));
    expect(rows).toHaveLength(1);
  });

  it('retries (never drops) a refund whose order is not stored yet, then emits once the order exists', async () => {
    const webhookEventId = await deliverRefund(5201, 102);

    const [pending] = await db.client.select().from(integrationWebhookEvents).where(eq(integrationWebhookEvents.id, webhookEventId));
    expect(pending.status).toBe('pending');
    expect(pending.error).toContain('not stored yet');
    expect(commerceEvents()).toEqual([]);

    await deliver('orders/create', { id: 102, updatedAt: '2026-03-11T10:00:00Z' });
    await db.client.execute(sql`update integration_webhook_events set next_attempt_at = now() - interval '1 second' where id = ${webhookEventId}`);
    emitted = [];
    await processor.processEvent(webhookEventId);

    expect(ofType('refund.processed').map((event) => (event.payload as unknown as RefundProcessedPayload).refundExternalId)).toEqual(['5201']);
  });

  it('emits nothing for import/sync/reconciliation (no emitDomainEvents) — backfilled history is not a live change', async () => {
    const order: NormalizedOrder = {
      externalId: '200',
      customerExternalId,
      totalPrice: '10.00',
      sourceUpdatedAt: new Date('2026-03-01T00:00:00Z'),
      sourceCreatedAt: new Date('2026-03-01T00:00:00Z'),
      sourceCancelledAt: new Date('2026-03-01T00:00:00Z'),
      lineItems: [],
      refunds: [{ externalId: '5200', note: null, totalRefunded: '10.00', processedAt: new Date('2026-03-01T00:00:00Z'), lineItems: [] }],
      fulfillments: [],
    };

    const result = await moduleRef.get(OrderService).upsertMany(workspaceId, integrationIds.shopify, 'shopify', [order]);

    expect(commerceEvents()).toEqual([]);
    expect(result.newOrderCanonicalCustomerIds).toEqual([canonicalCustomerId]);
  });

  it('produces the same events from a WooCommerce order (provider-neutral contract)', async () => {
    const orderService = moduleRef.get(OrderService);
    const base: NormalizedOrder = {
      externalId: '300',
      customerExternalId,
      totalPrice: '20.00',
      sourceUpdatedAt: new Date('2026-03-01T00:00:00Z'),
      sourceCreatedAt: new Date('2026-03-01T00:00:00Z'),
      sourceCancelledAt: null,
      lineItems: [],
      refunds: [],
      fulfillments: [],
    };

    await orderService.upsertMany(workspaceId, integrationIds.woocommerce, 'woocommerce', [base], { emitDomainEvents: true });
    await orderService.upsertMany(
      workspaceId,
      integrationIds.woocommerce,
      'woocommerce',
      [{ ...base, sourceUpdatedAt: new Date('2026-03-02T00:00:00Z'), sourceCancelledAt: new Date('2026-03-02T00:00:00Z') }],
      { emitDomainEvents: true },
    );

    expect(commerceEvents().map((event) => event.type)).toEqual(['order.created', 'order.updated', 'order.cancelled']);
    for (const event of commerceEvents() as DomainEvent<OrderEventPayload>[]) {
      expect(event.payload).toMatchObject({ provider: 'woocommerce', orderExternalId: '300', canonicalCustomerId });
    }
  });

  describe('WooCommerce refund summaries (order-embedded, summary-only)', () => {
    /** A REST-shaped WooCommerce order webhook body; `refunds` uses the documented summary shape (negative `total`). */
    function wooOrderBody(id: number, dateModifiedGmt: string, refunds: Array<{ id: number; reason: string; total: string }> = []) {
      return JSON.stringify({
        id,
        customer_id: Number(customerExternalId),
        total: '20.00',
        status: 'processing',
        date_created_gmt: '2026-04-01T00:00:00',
        date_modified_gmt: dateModifiedGmt,
        line_items: [],
        refunds,
      });
    }

    async function deliverWoo(topic: 'order.created' | 'order.updated', body: string, deliveryId: string = randomUUID()) {
      const headers = {
        'x-wc-webhook-topic': topic,
        'x-wc-webhook-signature': createHmac('sha256', webhookSecret).update(body, 'utf8').digest('base64'),
        'x-wc-webhook-delivery-id': deliveryId,
      };
      const result = await ingestWithoutWake(body, headers, 'woocommerce');
      await processor.processEvent(result);
      return headers;
    }

    const wooOrderRow = async (externalId: string) =>
      (
        await db.client
          .select()
          .from(commerceOrders)
          .where(and(eq(commerceOrders.workspaceId, workspaceId), eq(commerceOrders.provider, 'woocommerce'), eq(commerceOrders.externalId, externalId)))
      )[0];
    const wooRefunds = (orderId: string) => db.client.select().from(commerceRefunds).where(eq(commerceRefunds.orderId, orderId)).orderBy(commerceRefunds.externalId);

    it('a refund arriving on order.updated emits refund.processed once, stores a positive amount with no date, and reduces the refundable amount', async () => {
      await deliverWoo('order.created', wooOrderBody(400, '2026-04-01T00:00:00'));
      emitted = [];

      const refunded = wooOrderBody(400, '2026-04-02T00:00:00', [{ id: 4001, reason: 'Damaged', total: '-7.50' }]);
      const headers = await deliverWoo('order.updated', refunded);

      const refundEvents = ofType('refund.processed') as unknown as DomainEvent<RefundProcessedPayload>[];
      expect(refundEvents).toHaveLength(1);
      expect(refundEvents[0].payload).toMatchObject({ provider: 'woocommerce', orderExternalId: '400', refundExternalId: '4001', totalRefunded: '7.50', canonicalCustomerId });
      const order = await wooOrderRow('400');
      expect(await wooRefunds(order.id)).toEqual([expect.objectContaining({ externalId: '4001', note: 'Damaged', totalRefunded: '7.50', processedAt: null })]);
      expect(await moduleRef.get(OrderService).findRefundableAmount(workspaceId, canonicalCustomerId, order.id)).toEqual({ amount: '12.50' });

      // The same WooCommerce delivery again: deduplicated before processing, no second event.
      emitted = [];
      expect(await ingest.ingest(workspaceId, 'woocommerce', refunded, headers)).toEqual({ status: 'duplicate' });
      expect(ofType('refund.processed')).toHaveLength(0);

      // A later update carrying the old refund plus a new one: only the new refund is reported.
      await deliverWoo('order.updated', wooOrderBody(400, '2026-04-03T00:00:00', [
        { id: 4001, reason: 'Damaged', total: '-7.50' },
        { id: 4002, reason: '', total: '-2.50' },
      ]));
      expect((ofType('refund.processed') as unknown as DomainEvent<RefundProcessedPayload>[]).map((event) => event.payload.refundExternalId)).toEqual(['4002']);
      expect(await moduleRef.get(OrderService).findRefundableAmount(workspaceId, canonicalCustomerId, order.id)).toEqual({ amount: '10.00' });
    });

    it('a historical import of an already-refunded order stores the refund silently and still counts it against the refundable amount', async () => {
      const adapterOrder = JSON.parse(wooOrderBody(401, '2026-04-05T00:00:00', [{ id: 4011, reason: 'Late', total: '-20.00' }])) as Record<string, unknown>;
      const parsed = moduleRef.get(WooCommerceAdapter).parseWebhookEvent(JSON.stringify(adapterOrder), { 'x-wc-webhook-topic': 'order.created' });
      const normalized = (parsed!.payload as { data: NormalizedOrder }).data;

      await moduleRef.get(OrderService).upsertMany(workspaceId, integrationIds.woocommerce, 'woocommerce', [normalized]);

      expect(ofType('refund.processed')).toHaveLength(0);
      const order = await wooOrderRow('401');
      expect(await wooRefunds(order.id)).toEqual([expect.objectContaining({ externalId: '4011', totalRefunded: '20.00', processedAt: null })]);
      expect(await moduleRef.get(OrderService).findRefundableAmount(workspaceId, canonicalCustomerId, order.id)).toEqual({ reason: 'The order has no refundable amount remaining.' });
    });
  });
});
