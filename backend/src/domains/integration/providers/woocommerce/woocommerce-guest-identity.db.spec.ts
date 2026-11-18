import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { AppModule } from '../../../../app.module';
import { DatabaseService } from '../../../../database/database.service';
import { workspaces } from '../../../../database/schema/workspaces';
import { integrations } from '../../../../database/schema/integrations';
import { integrationWebhookEvents } from '../../../../database/schema/integration-webhook-events';
import { commerceCustomers } from '../../../../database/schema/commerce-customers';
import { commerceOrders } from '../../../../database/schema/commerce-orders';
import { commerceOrderLineItems } from '../../../../database/schema/commerce-order-line-items';
import { canonicalCustomers } from '../../../../database/schema/canonical-customers';
import { canonicalCustomerDuplicates } from '../../../../database/schema/canonical-customer-duplicates';
import { identityMergeHistory } from '../../../../database/schema/identity-merge-history';
import { customerHealthStates } from '../../../../database/schema/customer-health-states';
import { customerHealthStateHistory } from '../../../../database/schema/customer-health-state-history';
import { revenueOpportunities } from '../../../../database/schema/revenue-opportunities';
import { recommendations } from '../../../../database/schema/recommendations';
import { EventBus } from '../../../../common/events/event-bus.service';
import type { DomainEvent } from '../../../../common/events/domain-event';
import type { OrderEventPayload } from '../../../commerce/commerce-events';
import { CustomerService } from '../../../commerce/customer.service';
import { OrderService, type NormalizedOrder } from '../../../commerce/order.service';
import { IdentityResolutionService } from '../../../identity-resolution/identity-resolution.service';
import { CustomerIntelligenceService } from '../../../customer-intelligence/customer-intelligence.service';
import { IntegrationService } from '../../integration.service';
import { WebhookIngestService } from '../../webhook-ingest.service';
import { WebhookEventProcessorService } from '../../webhook-event-processor.service';
import { upsertGuestCustomers } from '../../guest-customers';
import { WooCommerceAdapter } from './woocommerce.adapter';

/**
 * Stage 10 Slice 4: WooCommerce guest checkouts (`customer_id` 0) resolved by normalized billing email through the
 * existing CustomerService → IdentityResolutionService path, end to end against the real dev DB: signed deliveries →
 * durable ingest → processor → guest source customer + identity resolution → order linked → order.created with a
 * canonical customer → health. Throwaway workspaces deleted in afterAll.
 */
describe('WooCommerce guest checkout identity (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let ingest: WebhookIngestService;
  let processor: WebhookEventProcessorService;
  let emitted: DomainEvent[] = [];
  let suppressWake = false;

  const wsA = randomUUID();
  const wsB = randomUUID();
  const secret = 'woo-guest-identity-secret';
  const integrationIds: Record<string, string> = {};

  function signed(topic: string, body: string, deliveryId: string = randomUUID()) {
    return {
      'x-wc-webhook-topic': topic,
      'x-wc-webhook-signature': createHmac('sha256', secret).update(body, 'utf8').digest('base64'),
      'x-wc-webhook-delivery-id': deliveryId,
    };
  }

  /** Ingest + process one delivery synchronously (wake-up suppressed so the test drives the processor itself). */
  async function deliver(ws: string, topic: string, payload: object, deliveryId?: string) {
    const body = JSON.stringify(payload);
    const headers = signed(topic, body, deliveryId);
    suppressWake = true;
    let result;
    try {
      result = await ingest.ingest(ws, 'woocommerce', body, headers);
    } finally {
      suppressWake = false;
    }
    if (result.status === 'accepted' && !(await processor.processEvent(result.webhookEventId))) {
      // Another processor sharing the dev DB claimed it first — wait for that run to finish instead of asserting early.
      const deadline = Date.now() + 15_000;
      while ((await db.client.select({ processedAt: integrationWebhookEvents.processedAt }).from(integrationWebhookEvents).where(eq(integrationWebhookEvents.id, result.webhookEventId)))[0]?.processedAt == null) {
        if (Date.now() > deadline) throw new Error(`webhook event ${result.webhookEventId} was never processed`);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    return { result, body, headers };
  }

  const guestOrder = (id: number, billing: object, modified = '2026-05-01T00:00:00') => ({
    id,
    customer_id: 0,
    total: '30.00',
    status: 'processing',
    date_created_gmt: modified,
    date_modified_gmt: modified,
    line_items: [{ id: id * 10, product_id: null, quantity: 1, price: '30.00' }],
    billing,
  });

  const order = async (ws: string, externalId: number) =>
    (await db.client.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, ws), eq(commerceOrders.provider, 'woocommerce'), eq(commerceOrders.externalId, String(externalId)))))[0];
  const sourceCustomer = async (ws: string, externalId: string) =>
    (await db.client.select().from(commerceCustomers).where(and(eq(commerceCustomers.workspaceId, ws), eq(commerceCustomers.provider, 'woocommerce'), eq(commerceCustomers.externalId, externalId))))[0];
  const canonicalsWithEmail = (ws: string, email: string) =>
    db.client.select().from(canonicalCustomers).where(and(eq(canonicalCustomers.workspaceId, ws), eq(canonicalCustomers.primaryEmail, email)));
  const orderCreated = () => emitted.filter((event) => event.type === 'order.created') as DomainEvent<OrderEventPayload>[];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    ingest = moduleRef.get(WebhookIngestService);
    processor = moduleRef.get(WebhookEventProcessorService);

    await db.client.insert(workspaces).values([
      { id: wsA, name: 'WooCommerce Guest Identity Test A' },
      { id: wsB, name: 'WooCommerce Guest Identity Test B' },
    ]);
    const integrationService = moduleRef.get(IntegrationService);
    for (const ws of [wsA, wsB]) {
      integrationIds[ws] = (await integrationService.connect(ws, 'woocommerce')).id;
      await integrationService.setCredentials(ws, 'woocommerce', {
        storeUrl: 'https://guest-identity-test.example.com',
        consumerKey: 'ck_unused',
        consumerSecret: 'cs_unused',
        webhookSecret: secret,
      });
    }

    const eventBus = moduleRef.get(EventBus);
    const original = EventBus.prototype.emit;
    vi.spyOn(eventBus, 'emit').mockImplementation(function (this: EventBus, event) {
      if (suppressWake && event.type === 'integration.webhook.received') return;
      emitted.push(event as DomainEvent);
      return original.call(this, event);
    });
  }, 60_000);

  beforeEach(() => {
    emitted = [];
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (db?.isConfigured()) {
      const ids = [wsA, wsB];
      // Health recalculation runs fire-and-forget off order.created; let in-flight writes settle before teardown.
      const writtenCount = async () => {
        let total = 0;
        for (const table of [customerHealthStateHistory, revenueOpportunities, recommendations]) {
          total += Number((await db.client.select({ n: sql<number>`count(*)` }).from(table).where(inArray(table.workspaceId, ids)))[0].n);
        }
        return total;
      };
      for (let previous = -1, current = await writtenCount(), i = 0; current !== previous && i < 10; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        [previous, current] = [current, await writtenCount()];
      }
      await db.client.delete(recommendations).where(inArray(recommendations.workspaceId, ids));
      await db.client.delete(revenueOpportunities).where(inArray(revenueOpportunities.workspaceId, ids));
      await db.client.delete(customerHealthStateHistory).where(inArray(customerHealthStateHistory.workspaceId, ids));
      await db.client.delete(customerHealthStates).where(inArray(customerHealthStates.workspaceId, ids));
      await db.client.delete(commerceOrderLineItems).where(inArray(commerceOrderLineItems.workspaceId, ids));
      await db.client.delete(commerceOrders).where(inArray(commerceOrders.workspaceId, ids));
      await db.client.delete(integrationWebhookEvents).where(inArray(integrationWebhookEvents.workspaceId, ids));
      await db.client.delete(canonicalCustomerDuplicates).where(inArray(canonicalCustomerDuplicates.workspaceId, ids));
      await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
      await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
      await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
      await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    }
    await moduleRef?.close();
  }, 60_000);

  it('a guest order creates one guest source customer, links the order to its canonical customer, and feeds purchase history and health', async () => {
    await deliver(wsA, 'order.created', guestOrder(5001, { first_name: 'Gia', last_name: 'Guest', email: 'Gia@Example.com', phone: '+14155550101' }));

    const guest = await sourceCustomer(wsA, 'guest:gia@example.com');
    expect(guest).toMatchObject({ email: 'gia@example.com', firstName: 'Gia', phoneE164: '+14155550101' });
    expect(guest.canonicalCustomerId).not.toBeNull();
    expect((await order(wsA, 5001)).customerId).toBe(guest.id);
    expect(orderCreated().map((event) => event.payload.canonicalCustomerId)).toEqual([guest.canonicalCustomerId]);

    const record = await moduleRef.get(CustomerIntelligenceService).getCustomer(wsA, guest.canonicalCustomerId!);
    expect(record.profile).toMatchObject({ email: 'gia@example.com', firstName: 'Gia' });
    expect(record.commerceContext).toMatchObject({ ordersCount: 1, totalSpent: '30.00' });

    // Health is recalculated off order.created (fire-and-forget) — poll for the guest's state.
    const deadline = Date.now() + 15_000;
    let health;
    while (!(health = (await db.client.select().from(customerHealthStates).where(eq(customerHealthStates.canonicalCustomerId, guest.canonicalCustomerId!)))[0])) {
      if (Date.now() > deadline) throw new Error('no health state for the guest customer');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(health.workspaceId).toBe(wsA);
  });

  it('repeat guest purchases (email in a different case) share the one guest record and canonical customer', async () => {
    const first = await sourceCustomer(wsA, 'guest:gia@example.com');

    await deliver(wsA, 'order.created', guestOrder(5002, { email: '  GIA@EXAMPLE.COM ', first_name: 'Gia' }, '2026-05-02T00:00:00'));

    const guests = await db.client.select().from(commerceCustomers).where(and(eq(commerceCustomers.workspaceId, wsA), like(commerceCustomers.externalId, 'guest:gia%')));
    expect(guests).toHaveLength(1);
    expect((await order(wsA, 5002)).customerId).toBe(first.id);
    expect(await canonicalsWithEmail(wsA, 'gia@example.com')).toHaveLength(1);
    const record = await moduleRef.get(CustomerIntelligenceService).getCustomer(wsA, first.canonicalCustomerId!);
    expect(record.commerceContext).toMatchObject({ ordersCount: 2, totalSpent: '60.00' });
  });

  it('a registered customer with the same email: the guest links to that canonical customer (no new one, no merge), both source records preserved', async () => {
    await deliver(wsA, 'customer.created', {
      id: 77,
      email: 'Reg@Example.com',
      first_name: 'Reg',
      last_name: 'Istered',
      billing: { phone: null },
      date_created_gmt: '2026-01-01T00:00:00',
      date_modified_gmt: '2026-01-01T00:00:00',
    });
    const registered = await sourceCustomer(wsA, '77');

    await deliver(wsA, 'order.created', guestOrder(5003, { email: 'reg@example.com' }));

    const guest = await sourceCustomer(wsA, 'guest:reg@example.com');
    expect(guest.canonicalCustomerId).toBe(registered.canonicalCustomerId);
    expect(await canonicalsWithEmail(wsA, 'reg@example.com')).toHaveLength(1);
    expect(await db.client.select().from(identityMergeHistory).where(eq(identityMergeHistory.workspaceId, wsA))).toHaveLength(0);
    const record = await moduleRef.get(CustomerIntelligenceService).getCustomer(wsA, registered.canonicalCustomerId!);
    expect(record.sourceCustomers.map((s) => s.externalId).sort()).toEqual(['77', 'guest:reg@example.com']);
  });

  it('missing or unusable email: the order stays unlinked and no customer or canonical customer is created — even when the phone matches a known customer', async () => {
    const before = await db.client.select({ n: sql<number>`count(*)::int` }).from(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, wsA));

    await deliver(wsA, 'order.created', guestOrder(5004, { email: '', phone: '+14155550101' }));
    await deliver(wsA, 'order.created', guestOrder(5005, { phone: '+14155550101' }));
    await deliver(wsA, 'order.created', guestOrder(5006, { email: 'not-an-email' }));

    for (const id of [5004, 5005, 5006]) expect((await order(wsA, id)).customerId).toBeNull();
    expect(orderCreated().every((event) => event.payload.canonicalCustomerId === null)).toBe(true);
    const after = await db.client.select({ n: sql<number>`count(*)::int` }).from(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, wsA));
    expect(after[0].n).toBe(before[0].n);
  });

  it('conflict: a guest sharing only a phone with another customer stays separate and is flagged for review, never merged', async () => {
    await deliver(wsA, 'order.created', guestOrder(5009, { email: 'phone-a@example.com', phone: '+14155550199' }));
    const gia = await sourceCustomer(wsA, 'guest:phone-a@example.com');

    await deliver(wsA, 'order.created', guestOrder(5007, { email: 'other@example.com', phone: '+1 (415) 555-0199' }));

    const other = await sourceCustomer(wsA, 'guest:other@example.com');
    expect(other.canonicalCustomerId).not.toBe(gia.canonicalCustomerId);
    const flags = await db.client.select().from(canonicalCustomerDuplicates).where(eq(canonicalCustomerDuplicates.workspaceId, wsA));
    expect(flags).toEqual([
      expect.objectContaining({ matchedSignal: 'phone', confidence: 'medium', matchedValue: '+14155550199' }),
    ]);
    expect([flags[0].canonicalCustomerAId, flags[0].canonicalCustomerBId].sort()).toEqual([gia.canonicalCustomerId, other.canonicalCustomerId].sort());
    expect(await db.client.select().from(identityMergeHistory).where(eq(identityMergeHistory.workspaceId, wsA))).toHaveLength(0);
  });

  it('webhook replay: the same delivery is deduplicated; a redelivery under a new id changes nothing and reports nothing new', async () => {
    const payload = guestOrder(5008, { email: 'replay@example.com' });
    const deliveryId = randomUUID();
    const first = await deliver(wsA, 'order.created', payload, deliveryId);
    expect(orderCreated()).toHaveLength(1);

    emitted = [];
    expect(await ingest.ingest(wsA, 'woocommerce', first.body, first.headers)).toEqual({ status: 'duplicate' });
    await deliver(wsA, 'order.created', payload);

    expect(orderCreated()).toHaveLength(0);
    expect(await db.client.select().from(commerceCustomers).where(and(eq(commerceCustomers.workspaceId, wsA), eq(commerceCustomers.externalId, 'guest:replay@example.com')))).toHaveLength(1);
    expect(await canonicalsWithEmail(wsA, 'replay@example.com')).toHaveLength(1);
  });

  it('tenant isolation: the same guest email in another workspace gets its own records and never touches the first', async () => {
    const inA = await sourceCustomer(wsA, 'guest:gia@example.com');

    await deliver(wsB, 'order.created', guestOrder(5001, { email: 'gia@example.com' }));

    const inB = await sourceCustomer(wsB, 'guest:gia@example.com');
    expect(inB.id).not.toBe(inA.id);
    expect(inB.canonicalCustomerId).not.toBe(inA.canonicalCustomerId);
    expect((await order(wsB, 5001)).customerId).toBe(inB.id);
    expect((await order(wsA, 5001)).customerId).toBe(inA.id);
    expect(await canonicalsWithEmail(wsA, 'gia@example.com')).toHaveLength(1);
  });

  it('guest name/phone: an order without them never clears them, and every arrival order (one by one or in one batch) gives the same result', async () => {
    const adapter = moduleRef.get(WooCommerceAdapter);
    const normalize = (payload: object) =>
      (adapter.parseWebhookEvent(JSON.stringify(payload), { 'x-wc-webhook-topic': 'order.updated' })!.payload as { data: NormalizedOrder }).data;
    const placed = (id: number, email: string, at: string, billing: object) =>
      normalize({ ...guestOrder(id, { email, ...billing }), date_created_gmt: at, date_modified_gmt: '2026-11-01T00:00:00' });
    // Jan: full details. Feb: newer name, no phone. Mar: newest phone, no name. Expected: Feb's name, Mar's phone.
    const orders = (email: string, base: number) => [
      placed(base + 1, email, '2026-01-10T00:00:00', { first_name: 'Ann', last_name: 'Old', phone: '+14155550111' }),
      placed(base + 2, email, '2026-02-10T00:00:00', { first_name: 'Anna', last_name: 'New' }),
      placed(base + 3, email, '2026-03-10T00:00:00', { phone: '+14155550133' }),
    ];
    const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const services = [moduleRef.get(CustomerService), moduleRef.get(IdentityResolutionService)] as const;

    const results = [];
    for (const [i, permutation] of permutations.entries()) {
      for (const mode of ['one-by-one', 'batch'] as const) {
        const email = `perm-${i}-${mode}@example.com`;
        const batch = permutation.map((index) => orders(email, 6100 + i * 10 + (mode === 'batch' ? 100 : 0))[index]);
        if (mode === 'batch') await upsertGuestCustomers(...services, wsA, integrationIds[wsA], 'woocommerce', batch);
        else for (const order of batch) await upsertGuestCustomers(...services, wsA, integrationIds[wsA], 'woocommerce', [order]);
        const row = await sourceCustomer(wsA, `guest:${email}`);
        results.push({ firstName: row.firstName, lastName: row.lastName, phone: row.phone, phoneE164: row.phoneE164 });
      }
    }

    for (const result of results) {
      expect(result).toEqual({ firstName: 'Anna', lastName: 'New', phone: '+14155550133', phoneE164: '+14155550133' });
    }

    // A later order with no name or phone at all changes nothing.
    await upsertGuestCustomers(...services, wsA, integrationIds[wsA], 'woocommerce', [placed(6999, 'perm-0-batch@example.com', '2026-10-01T00:00:00', {})]);
    expect(await sourceCustomer(wsA, 'guest:perm-0-batch@example.com')).toMatchObject({ firstName: 'Anna', lastName: 'New', phone: '+14155550133' });
  });

  it('eligible guest purchases create revenue opportunities through the live pipeline; a repeat order and a replay add no duplicates', async () => {
    const email = 'opps@example.com';
    const opportunities = async (canonicalCustomerId: string) =>
      db.client.select().from(revenueOpportunities).where(and(eq(revenueOpportunities.workspaceId, wsA), eq(revenueOpportunities.canonicalCustomerId, canonicalCustomerId)));
    const typesOf = async (canonicalCustomerId: string) => (await opportunities(canonicalCustomerId)).map((row) => row.type).sort();
    /** Opportunity evaluation runs fire-and-forget off order.created / health — poll until the expected set appears and stays put. */
    async function settledTypes(canonicalCustomerId: string, expected: string[]) {
      const deadline = Date.now() + 20_000;
      let types: string[] = [];
      while (Date.now() < deadline) {
        types = await typesOf(canonicalCustomerId);
        if (JSON.stringify(types) === JSON.stringify(expected)) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return typesOf(canonicalCustomerId);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return types;
    }
    const placedOrder = (id: number, at: string) => ({ ...guestOrder(id, { email, first_name: 'Opal' }), date_created_gmt: at, date_modified_gmt: at });

    // First guest purchase (long ago): past the win-back threshold.
    await deliver(wsA, 'order.created', placedOrder(6201, '2026-01-10T00:00:00'));
    const guest = await sourceCustomer(wsA, `guest:${email}`);
    expect(await settledTypes(guest.canonicalCustomerId!, ['win_back'])).toEqual(['win_back']);

    // Repeat purchase a month later: now also a reorder candidate; win-back is not duplicated.
    const repeat = placedOrder(6202, '2026-02-10T00:00:00');
    const repeatDelivery = await deliver(wsA, 'order.created', repeat);
    expect(await settledTypes(guest.canonicalCustomerId!, ['reorder', 'win_back'])).toEqual(['reorder', 'win_back']);
    const before = await opportunities(guest.canonicalCustomerId!);
    expect(await db.client.select().from(recommendations).where(inArray(recommendations.sourceOpportunityId, before.map((row) => row.id)))).toHaveLength(2);

    // Replay: the same delivery is deduplicated; a redelivery under a new id emits nothing and creates nothing.
    emitted = [];
    expect(await ingest.ingest(wsA, 'woocommerce', repeatDelivery.body, repeatDelivery.headers)).toEqual({ status: 'duplicate' });
    await deliver(wsA, 'order.created', repeat);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(orderCreated()).toHaveLength(0);
    expect((await opportunities(guest.canonicalCustomerId!)).map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
  });

  it('import/sync/reconciliation batches: repeat guests in one page dedupe, and an older unlinked guest order is linked when re-upserted', async () => {
    const adapter = moduleRef.get(WooCommerceAdapter);
    const normalize = (payload: object) =>
      (adapter.parseWebhookEvent(JSON.stringify(payload), { 'x-wc-webhook-topic': 'order.updated' })!.payload as { data: NormalizedOrder }).data;
    const orderService = moduleRef.get(OrderService);
    const ingestBatch = async (orders: NormalizedOrder[]) => {
      // The exact two calls every order path (import, sync, reconciliation) now makes.
      await upsertGuestCustomers(moduleRef.get(CustomerService), moduleRef.get(IdentityResolutionService), wsA, integrationIds[wsA], 'woocommerce', orders);
      return orderService.upsertMany(wsA, integrationIds[wsA], 'woocommerce', orders);
    };

    // An order stored before guest resolution existed: no customer link.
    const legacy = normalize(guestOrder(5101, { email: 'batch@example.com' }));
    await orderService.upsertMany(wsA, integrationIds[wsA], 'woocommerce', [{ ...legacy, customerExternalId: null, guestCustomer: undefined }]);
    expect((await order(wsA, 5101)).customerId).toBeNull();

    const result = await ingestBatch([
      legacy,
      normalize(guestOrder(5102, { email: 'Batch@Example.com' })),
      normalize(guestOrder(5103, { email: 'batch@example.com' })),
    ]);

    const guest = await sourceCustomer(wsA, 'guest:batch@example.com');
    expect(result.newOrderCanonicalCustomerIds).toEqual([guest.canonicalCustomerId]);
    for (const id of [5101, 5102, 5103]) expect((await order(wsA, id)).customerId).toBe(guest.id);
    // Historical batches stay silent — no order.created from import/sync/reconciliation.
    expect(orderCreated()).toHaveLength(0);
  });
});
