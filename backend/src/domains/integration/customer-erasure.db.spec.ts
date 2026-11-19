import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray, sql } from 'drizzle-orm';

vi.hoisted(() => {
  process.env.ERASURE_HMAC_SECRET = 'customer-erasure-db-spec-secret-0123456789abcdef';
});

import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { integrations } from '../../database/schema/integrations';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { commerceOrderLineItems } from '../../database/schema/commerce-order-line-items';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { canonicalCustomerDuplicates } from '../../database/schema/canonical-customer-duplicates';
import { customerHealthStates } from '../../database/schema/customer-health-states';
import { customerHealthStateHistory } from '../../database/schema/customer-health-state-history';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { erasedCustomerIdentifiers } from '../../database/schema/erased-customer-identifiers';
import { customerErasures } from '../../database/schema/customer-erasures';
import { EventBus } from '../../common/events/event-bus.service';
import { CustomerService, type NormalizedCustomer } from '../commerce/customer.service';
import { OrderService, type NormalizedOrder } from '../commerce/order.service';
import { ErasedIdentifierService } from '../commerce/erased-identifier.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { IntegrationService } from './integration.service';
import { WebhookIngestService } from './webhook-ingest.service';
import { WebhookEventProcessorService } from './webhook-event-processor.service';
import { CustomerErasureService } from './customer-erasure.service';
import { upsertGuestCustomers } from './guest-customers';
import { WooCommerceAdapter } from './providers/woocommerce/woocommerce.adapter';

/**
 * Stage 10 erasure slices 2–3 end to end against the real dev DB: one person with a registered WooCommerce account,
 * guest WooCommerce orders, a Shopify record and a merged-in customer is erased in one call — every source record,
 * order and canonical row gone, raw webhook payloads cleared (rows kept for de-duplication), identifiers blocked so
 * re-import / sync / webhook redelivery recreate nothing, a concurrent in-flight write is waited for and erased too,
 * and other customers and workspaces are untouched.
 */
describe('Person-level customer erasure (real DB)', { timeout: 120_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let ingest: WebhookIngestService;
  let processor: WebhookEventProcessorService;
  let customers: CustomerService;
  let orders: OrderService;
  let identity: IdentityResolutionService;
  let erasure: CustomerErasureService;
  let suppressWake = false;
  const wsA = randomUUID();
  const wsB = randomUUID();
  const secret = 'customer-erasure-webhook-secret';
  const integrationIds: Record<string, Record<string, string>> = { [wsA]: {}, [wsB]: {} };

  const customerFor = (externalId: string, email: string): NormalizedCustomer => ({
    externalId,
    email,
    firstName: 'Per',
    lastName: 'Son',
    phone: null,
    sourceUpdatedAt: null,
    sourceCreatedAt: null,
  });
  const plainOrder = (externalId: string, customerExternalId: string | null): NormalizedOrder => ({
    externalId,
    customerExternalId,
    totalPrice: '20.00',
    sourceUpdatedAt: new Date('2026-04-01T00:00:00Z'),
    sourceCreatedAt: new Date('2026-04-01T00:00:00Z'),
    lineItems: [
      { externalId: `${externalId}-li`, variantExternalId: null, quantity: 1, price: '20.00' },
    ],
    refunds: [],
    fulfillments: [],
  });
  const wooOrder = (id: number, customerId: number, email: string) => ({
    id,
    customer_id: customerId,
    total: '20.00',
    status: 'processing',
    date_created_gmt: '2026-04-01T00:00:00',
    date_modified_gmt: '2026-04-01T00:00:00',
    line_items: [],
    billing: { email, first_name: 'Per' },
  });
  const wooCustomer = (id: number, email: string) => ({
    id,
    email,
    first_name: 'Per',
    last_name: 'Son',
    billing: { phone: null },
    date_created_gmt: null,
    date_modified_gmt: null,
  });

  async function deliver(
    ws: string,
    topic: string,
    payload: object,
    deliveryId: string = randomUUID(),
  ) {
    const body = JSON.stringify(payload);
    const headers = {
      'x-wc-webhook-topic': topic,
      'x-wc-webhook-signature': createHmac('sha256', secret).update(body, 'utf8').digest('base64'),
      'x-wc-webhook-delivery-id': deliveryId,
    };
    suppressWake = true;
    let result;
    try {
      result = await ingest.ingest(ws, 'woocommerce', body, headers);
    } finally {
      suppressWake = false;
    }
    if (result.status === 'accepted' && !(await processor.processEvent(result.webhookEventId))) {
      const deadline = Date.now() + 15_000;
      while (
        (
          await db.client
            .select({ processedAt: integrationWebhookEvents.processedAt })
            .from(integrationWebhookEvents)
            .where(eq(integrationWebhookEvents.id, result.webhookEventId))
        )[0]?.processedAt == null
      ) {
        if (Date.now() > deadline) throw new Error('webhook event was never processed');
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    return { result, body, headers };
  }

  const source = async (ws: string, provider: string, externalId: string) =>
    (
      await db.client
        .select()
        .from(commerceCustomers)
        .where(
          and(
            eq(commerceCustomers.workspaceId, ws),
            eq(commerceCustomers.provider, provider as 'woocommerce'),
            eq(commerceCustomers.externalId, externalId),
          ),
        )
    )[0];
  const orderRow = async (ws: string, provider: string, externalId: string) =>
    (
      await db.client
        .select()
        .from(commerceOrders)
        .where(
          and(
            eq(commerceOrders.workspaceId, ws),
            eq(commerceOrders.provider, provider as 'woocommerce'),
            eq(commerceOrders.externalId, externalId),
          ),
        )
    )[0];
  const canonical = async (id: string) =>
    (await db.client.select().from(canonicalCustomers).where(eq(canonicalCustomers.id, id)))[0];

  /** Builds the person in `ws`: Woo registered 77 + guest orders, Shopify s-1, and a merged-in customer (Woo 78). */
  async function seedPerson(ws: string, email: string) {
    const ids = integrationIds[ws];
    await deliver(ws, 'customer.created', wooCustomer(77, email));
    await deliver(ws, 'order.created', wooOrder(7001, 0, email)); // guest order, same email
    await deliver(ws, 'order.created', wooOrder(7002, 77, email)); // registered order
    await customers.upsertMany(ws, ids.shopify, 'shopify', [customerFor('s-1', email)]);
    await identity.resolveMany(ws, 'shopify', ['s-1']);
    await orders.upsertMany(ws, ids.shopify, 'shopify', [plainOrder('s-o-1', 's-1')]);
    const person = (await source(ws, 'woocommerce', '77')).canonicalCustomerId!;

    // A customer merged into the person (as IdentityResolutionService.merge leaves it: merged row points at the
    // survivor, its source record moved over).
    await deliver(ws, 'customer.created', wooCustomer(78, `alias-${email}`));
    const mergedId = (await source(ws, 'woocommerce', '78')).canonicalCustomerId!;
    await db.client
      .update(canonicalCustomers)
      .set({ mergedIntoId: person })
      .where(eq(canonicalCustomers.id, mergedId));
    await db.client
      .update(commerceCustomers)
      .set({ canonicalCustomerId: person })
      .where(and(eq(commerceCustomers.workspaceId, ws), eq(commerceCustomers.externalId, '78')));
    return { person, mergedId };
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured())
      throw new Error(
        'DATABASE_URL is not configured — this integration test requires the real dev database.',
      );
    ingest = moduleRef.get(WebhookIngestService);
    processor = moduleRef.get(WebhookEventProcessorService);
    customers = moduleRef.get(CustomerService);
    orders = moduleRef.get(OrderService);
    identity = moduleRef.get(IdentityResolutionService);
    erasure = moduleRef.get(CustomerErasureService);

    const eventBus = moduleRef.get(EventBus);
    const original = EventBus.prototype.emit;
    vi.spyOn(eventBus, 'emit').mockImplementation(function (this: EventBus, event) {
      if (suppressWake && event.type === 'integration.webhook.received') return;
      return original.call(this, event);
    });

    await db.client.insert(workspaces).values([
      { id: wsA, name: 'Customer Erasure Test A' },
      { id: wsB, name: 'Customer Erasure Test B' },
    ]);
    const integrationService = moduleRef.get(IntegrationService);
    for (const ws of [wsA, wsB]) {
      for (const provider of ['woocommerce', 'shopify'] as const)
        integrationIds[ws][provider] = (await integrationService.connect(ws, provider)).id;
      await integrationService.setCredentials(ws, 'woocommerce', {
        storeUrl: 'https://erasure.example.com',
        consumerKey: 'ck',
        consumerSecret: 'cs',
        webhookSecret: secret,
      });
    }
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (db?.isConfigured()) {
      const ids = [wsA, wsB];
      await new Promise((resolve) => setTimeout(resolve, 3000)); // let fire-and-forget health/opportunity handlers finish
      for (const table of [
        recommendations,
        revenueOpportunities,
        customerHealthStateHistory,
        customerHealthStates,
        canonicalCustomerDuplicates,
      ]) {
        await db.client.delete(table).where(inArray(table.workspaceId, ids));
      }
      await db.client
        .delete(commerceOrderLineItems)
        .where(inArray(commerceOrderLineItems.workspaceId, ids));
      await db.client.delete(commerceOrders).where(inArray(commerceOrders.workspaceId, ids));
      await db.client
        .delete(integrationWebhookEvents)
        .where(inArray(integrationWebhookEvents.workspaceId, ids));
      await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
      await db.client
        .update(canonicalCustomers)
        .set({ mergedIntoId: null })
        .where(inArray(canonicalCustomers.workspaceId, ids));
      await db.client
        .delete(canonicalCustomers)
        .where(inArray(canonicalCustomers.workspaceId, ids));
      await db.client
        .delete(erasedCustomerIdentifiers)
        .where(inArray(erasedCustomerIdentifiers.workspaceId, ids));
      await db.client.delete(customerErasures).where(inArray(customerErasures.workspaceId, ids));
      await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
      await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    }
    await moduleRef?.close();
  }, 90_000);

  it('erases the whole person across providers, guest and merged identities; others and other workspaces are untouched', async () => {
    const { person, mergedId } = await seedPerson(wsA, 'person@example.com');
    await seedPerson(wsB, 'person@example.com');
    await deliver(wsA, 'customer.created', wooCustomer(99, 'keeper@example.com'));
    await deliver(wsA, 'order.created', wooOrder(7099, 99, 'keeper@example.com'));
    const guest = await source(wsA, 'woocommerce', 'guest:person@example.com');
    expect(guest.canonicalCustomerId).toBe(person);
    // A not-yet-processed delivery for this person, and a dead-lettered one.
    const [pending] = await db.client
      .insert(integrationWebhookEvents)
      .values({
        workspaceId: wsA,
        integrationId: integrationIds[wsA].woocommerce,
        externalEventId: randomUUID(),
        eventType: 'customer.updated',
        status: 'pending',
        nextAttemptAt: new Date(Date.now() + 3_600_000),
        payload: { resource: 'customer', data: customerFor('77', 'person@example.com') },
      })
      .returning();
    const [dead] = await db.client
      .insert(integrationWebhookEvents)
      .values({
        workspaceId: wsA,
        integrationId: integrationIds[wsA].woocommerce,
        externalEventId: randomUUID(),
        eventType: 'order.updated',
        status: 'dead_letter',
        error: 'boom',
        payload: {
          resource: 'order',
          data: {
            ...plainOrder('7001', 'guest:person@example.com'),
            guestCustomer: { email: 'person@example.com' },
          },
        },
      })
      .returning();

    // Erasing via the merged-in id resolves to the survivor: the same person.
    const result = await erasure.eraseCanonicalCustomer(wsA, mergedId, 'clerk_owner');

    expect(result).toMatchObject({
      canonicalCustomerId: person,
      sourceCustomersErased: 4,
      ordersErased: 3,
    });
    expect(result.webhookPayloadsCleared).toBeGreaterThanOrEqual(5);
    expect(await canonical(person)).toBeUndefined();
    expect(await canonical(mergedId)).toBeUndefined();
    for (const [provider, id] of [
      ['woocommerce', '77'],
      ['woocommerce', '78'],
      ['woocommerce', 'guest:person@example.com'],
      ['shopify', 's-1'],
    ]) {
      expect(await source(wsA, provider, id)).toBeUndefined();
    }
    for (const [provider, id] of [
      ['woocommerce', '7001'],
      ['woocommerce', '7002'],
      ['shopify', 's-o-1'],
    ]) {
      expect(await orderRow(wsA, provider, id)).toBeUndefined();
    }
    expect(await source(wsA, 'woocommerce', '99')).toBeDefined();
    expect((await orderRow(wsA, 'woocommerce', '7099')).customerId).not.toBeNull();
    expect(await source(wsB, 'woocommerce', '77')).toBeDefined();
    expect(await source(wsB, 'woocommerce', 'guest:person@example.com')).toBeDefined();

    // Raw payloads cleared, rows kept; not-yet-processed rows completed.
    const [pendingAfter] = await db.client
      .select()
      .from(integrationWebhookEvents)
      .where(eq(integrationWebhookEvents.id, pending.id));
    expect(pendingAfter).toMatchObject({ payload: null, status: 'processed', error: null });
    const [deadAfter] = await db.client
      .select()
      .from(integrationWebhookEvents)
      .where(eq(integrationWebhookEvents.id, dead.id));
    expect(deadAfter).toMatchObject({ payload: null, status: 'processed', error: null });
    const leftovers = await db.client
      .select({ id: integrationWebhookEvents.id })
      .from(integrationWebhookEvents)
      .where(
        and(
          eq(integrationWebhookEvents.workspaceId, wsA),
          sql`${integrationWebhookEvents.payload}::text ilike '%person@example.com%'`,
        ),
      );
    expect(leftovers).toHaveLength(0);
    const wsBPayloads = await db.client
      .select({ id: integrationWebhookEvents.id })
      .from(integrationWebhookEvents)
      .where(
        and(
          eq(integrationWebhookEvents.workspaceId, wsB),
          sql`${integrationWebhookEvents.payload}::text ilike '%person@example.com%'`,
        ),
      );
    expect(wsBPayloads.length).toBeGreaterThan(0);

    // Non-personal audit record and the block list.
    const [audit] = await db.client
      .select()
      .from(customerErasures)
      .where(eq(customerErasures.workspaceId, wsA));
    expect(audit).toMatchObject({
      actorUserId: 'clerk_owner',
      canonicalCustomerId: person,
      sourceCustomersErased: 4,
      ordersErased: 3,
    });
    expect(JSON.stringify(audit)).not.toContain('person@example.com');
    const blocked = await db.client
      .select()
      .from(erasedCustomerIdentifiers)
      .where(eq(erasedCustomerIdentifiers.workspaceId, wsA));
    expect(blocked).toHaveLength(result.identifiersBlocked);
    expect(JSON.stringify(blocked)).not.toMatch(/person@example\.com|"77"|s-1/);
  });

  it('nothing comes back: re-import, sync, guest orders, webhook replay and redelivery under a new id', async () => {
    const ids = integrationIds[wsA];
    const replay = await db.client
      .select()
      .from(integrationWebhookEvents)
      .where(
        and(
          eq(integrationWebhookEvents.workspaceId, wsA),
          eq(integrationWebhookEvents.eventType, 'customer.created'),
        ),
      );
    expect(replay.length).toBeGreaterThan(0);

    // Same delivery id again → still de-duplicated (row kept).
    const sameDelivery = JSON.stringify(wooCustomer(77, 'person@example.com'));
    expect(
      await ingest.ingest(wsA, 'woocommerce', sameDelivery, {
        'x-wc-webhook-topic': 'customer.created',
        'x-wc-webhook-signature': createHmac('sha256', secret)
          .update(sameDelivery, 'utf8')
          .digest('base64'),
        'x-wc-webhook-delivery-id': replay[0].externalEventId,
      }),
    ).toEqual({ status: 'duplicate' });

    // Redelivery under new ids, re-import pages and a sync batch.
    await deliver(wsA, 'customer.updated', wooCustomer(77, 'person@example.com'));
    await deliver(wsA, 'order.updated', wooOrder(7001, 0, 'Person@Example.com'));
    await deliver(wsA, 'order.updated', wooOrder(7002, 77, 'person@example.com'));
    await deliver(wsA, 'order.created', wooOrder(7100, 0, 'person@example.com')); // a new guest order, same email
    await customers.upsertMany(wsA, ids.woocommerce, 'woocommerce', [
      customerFor('77', 'changed@example.com'),
      customerFor('555', 'person@example.com'),
    ]);
    await customers.upsertMany(wsA, ids.shopify, 'shopify', [
      customerFor('s-1', 'other@example.com'),
    ]);
    await orders.upsertMany(wsA, ids.shopify, 'shopify', [plainOrder('s-o-1', 's-1')]);
    const adapter = moduleRef.get(WooCommerceAdapter);
    const guestBatch = [
      (
        adapter.parseWebhookEvent(JSON.stringify(wooOrder(7101, 0, 'person@example.com')), {
          'x-wc-webhook-topic': 'order.updated',
        })!.payload as { data: NormalizedOrder }
      ).data,
    ];
    await upsertGuestCustomers(
      customers,
      identity,
      wsA,
      ids.woocommerce,
      'woocommerce',
      guestBatch,
    );
    await orders.upsertMany(wsA, ids.woocommerce, 'woocommerce', guestBatch);

    const personRows = await db.client
      .select({ externalId: commerceCustomers.externalId })
      .from(commerceCustomers)
      .where(
        and(
          eq(commerceCustomers.workspaceId, wsA),
          inArray(commerceCustomers.externalId, ['77', '555', 's-1', 'guest:person@example.com']),
        ),
      );
    expect(personRows).toEqual([]);
    expect(
      await db.client
        .select()
        .from(canonicalCustomers)
        .where(
          and(
            eq(canonicalCustomers.workspaceId, wsA),
            eq(canonicalCustomers.primaryEmail, 'person@example.com'),
          ),
        ),
    ).toEqual([]);
    for (const [provider, id] of [
      ['woocommerce', '7001'],
      ['woocommerce', '7002'],
      ['shopify', 's-o-1'],
    ]) {
      expect(await orderRow(wsA, provider, id)).toBeUndefined();
    }
    // New orders after the erasure may be stored, but never linked to anyone.
    expect((await orderRow(wsA, 'woocommerce', '7100')).customerId).toBeNull();
    expect((await orderRow(wsA, 'woocommerce', '7101')).customerId).toBeNull();
  });

  it('an in-flight write is waited for and erased with the rest; a second erasure and a cross-workspace id are 404', async () => {
    await deliver(wsB, 'customer.created', wooCustomer(300, 'race@example.com'));
    const person = (await source(wsB, 'woocommerce', '300')).canonicalCustomerId!;

    // Simulate an ingestion transaction that is mid-write (holds the shared lock) when the erasure starts.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => (lockHeld = resolve));
    const inflight = db.transaction(async (tx) => {
      await moduleRef.get(ErasedIdentifierService).lockShared(tx, wsB);
      // Not yet linked by identity resolution (and so no row lock on the canonical customer): only the erasure lock
      // makes the erasure wait for it.
      await tx
        .insert(commerceCustomers)
        .values({
          workspaceId: wsB,
          integrationId: integrationIds[wsB].woocommerce,
          provider: 'woocommerce',
          externalId: '301',
          email: ' Race@Example.com',
          canonicalCustomerId: null,
        });
      lockHeld();
      await gate;
    });
    await held;

    let erased = false;
    const erasing = erasure.eraseCanonicalCustomer(wsB, person, 'clerk_owner').then((value) => {
      erased = true;
      return value;
    });
    // Deterministic: Postgres shows the erasure queued behind the in-flight write on this workspace's erasure lock.
    const waitingOnErasureLock = async () =>
      Number(
        (
          await db.client.execute(sql`
            select count(*) as n from pg_locks l, (select hashtextextended(${`customer-erasure:${wsB}`}, 0) as k) key
            where l.locktype = 'advisory' and not l.granted
              and l.classid::bigint = ((key.k >> 32) & 4294967295) and l.objid::bigint = (key.k & 4294967295)`)
        ).rows[0].n,
      );
    const deadline = Date.now() + 15_000;
    while ((await waitingOnErasureLock()) === 0) {
      if (Date.now() > deadline) throw new Error('the erasure never waited on the erasure lock');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(erased).toBe(false);

    release();
    await inflight;
    const result = await erasing;

    expect(result.sourceCustomersErased).toBe(2);
    expect(await source(wsB, 'woocommerce', '301')).toBeUndefined();
    expect(await source(wsB, 'woocommerce', '300')).toBeUndefined();
    await expect(erasure.eraseCanonicalCustomer(wsB, person, 'clerk_owner')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const wsBPerson = (await source(wsB, 'woocommerce', '77')).canonicalCustomerId!;
    await expect(
      erasure.eraseCanonicalCustomer(wsA, wsBPerson, 'clerk_owner'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      erasure.eraseCanonicalCustomer(wsA, 'not-a-uuid', 'clerk_owner'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await canonical(wsBPerson)).toBeDefined();
  });
});
