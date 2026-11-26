import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray, sql } from 'drizzle-orm';

vi.hoisted(() => {
  process.env.ERASURE_HMAC_SECRET = 'checkout-sessions-spec-secret-0123456789abcdef';
});

import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { integrations } from '../../database/schema/integrations';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { checkoutSessions } from '../../database/schema/checkout-sessions';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { canonicalCustomerDuplicates } from '../../database/schema/canonical-customer-duplicates';
import { customerErasures } from '../../database/schema/customer-erasures';
import { erasedCustomerIdentifiers } from '../../database/schema/erased-customer-identifiers';
import type { DomainEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { CustomerService } from '../commerce/customer.service';
import { OrderService, type NormalizedOrder } from '../commerce/order.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import {
  CustomerIntelligenceService,
  withoutUnverifiedCheckouts,
} from '../customer-intelligence/customer-intelligence.service';
import { IntegrationService } from './integration.service';
import { WebhookIngestService } from './webhook-ingest.service';
import {
  WebhookEventProcessorService,
  type CheckoutAbandonedPayload,
} from './webhook-event-processor.service';
import { CustomerErasureService } from './customer-erasure.service';
import { applyCheckoutSessionRetention } from './checkout-session.service';
import { FlexyPeWebhookSetupService } from './providers/flexype/flexype-webhook-setup.service';
import {
  flexypeAbandonedCheckout,
  flexypeHeaders,
} from './providers/flexype/flexype.test-fixtures';

/**
 * FlexyPe Slice 2 against the real dev DB, simulated 2026-05 deliveries only: link-only identity (exact email to an
 * existing customer, never phone, never created), activity history with Shopify-order correlation by the documented
 * session id, retention + late link, erasure across providers, and tenant isolation. Throwaway workspaces.
 */
describe('Checkout sessions — identity, activity, privacy (real DB)', { timeout: 120_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let integrationService: IntegrationService;
  let ingest: WebhookIngestService;
  let processor: WebhookEventProcessorService;
  let customers: CustomerService;
  let orders: OrderService;
  let identity: IdentityResolutionService;
  let ucir: CustomerIntelligenceService;
  const emitted: DomainEvent<CheckoutAbandonedPayload>[] = [];
  const ws = { a: randomUUID(), b: randomUUID() };
  const shop = {
    a: `checkout-spec-a-${randomUUID().slice(0, 8)}.myshopify.com`,
    b: `checkout-spec-b-${randomUUID().slice(0, 8)}.myshopify.com`,
  };
  const shopifyId: Record<string, string> = {};
  const secret: Record<string, string> = {};

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error(
        'DATABASE_URL is not configured — this integration test requires the real dev database.',
      );
    }
    integrationService = moduleRef.get(IntegrationService);
    ingest = moduleRef.get(WebhookIngestService);
    processor = moduleRef.get(WebhookEventProcessorService);
    customers = moduleRef.get(CustomerService);
    orders = moduleRef.get(OrderService);
    identity = moduleRef.get(IdentityResolutionService);
    ucir = moduleRef.get(CustomerIntelligenceService);
    const bus = moduleRef.get(EventBus);
    const emit = bus.emit.bind(bus);
    vi.spyOn(bus, 'emit').mockImplementation((event: DomainEvent) => {
      if (event.type === 'checkout.abandoned')
        emitted.push(event as DomainEvent<CheckoutAbandonedPayload>);
      return emit(event);
    });

    await db.client.insert(workspaces).values([
      { id: ws.a, name: 'Checkout Spec A' },
      { id: ws.b, name: 'Checkout Spec B' },
    ]);
    const setup = moduleRef.get(FlexyPeWebhookSetupService);
    for (const [key, id] of Object.entries(ws) as ['a' | 'b', string][]) {
      shopifyId[id] = (await integrationService.connect(id, 'shopify')).id;
      await integrationService.setCredentials(id, 'shopify', {
        shopDomain: shop[key],
        accessToken: 'shpat_test',
      });
      await integrationService.connect(id, 'flexype');
      secret[id] = (await setup.generateSecret(id)).webhookSecret;
    }
  }, 120_000);

  afterAll(async () => {
    if (db?.isConfigured()) {
      const ids = Object.values(ws);
      await db.client.delete(checkoutSessions).where(inArray(checkoutSessions.workspaceId, ids));
      await db.client
        .delete(integrationWebhookEvents)
        .where(inArray(integrationWebhookEvents.workspaceId, ids));
      await db.client.delete(customerErasures).where(inArray(customerErasures.workspaceId, ids));
      await db.client
        .delete(erasedCustomerIdentifiers)
        .where(inArray(erasedCustomerIdentifiers.workspaceId, ids));
      await db.client.delete(commerceOrders).where(inArray(commerceOrders.workspaceId, ids));
      await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
      await db.client
        .delete(canonicalCustomerDuplicates)
        .where(inArray(canonicalCustomerDuplicates.workspaceId, ids));
      await db.client
        .update(canonicalCustomers)
        .set({ mergedIntoId: null })
        .where(inArray(canonicalCustomers.workspaceId, ids));
      await db.client
        .delete(canonicalCustomers)
        .where(inArray(canonicalCustomers.workspaceId, ids));
      await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
      await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    }
    vi.restoreAllMocks();
    await moduleRef?.close();
  }, 120_000);

  /** A Shopify customer resolved to a canonical customer; returns the canonical id. */
  async function shopifyCustomer(
    workspaceId: string,
    externalId: string,
    email: string | null,
    phone: string | null = null,
  ): Promise<string> {
    await customers.upsertMany(workspaceId, shopifyId[workspaceId], 'shopify', [
      {
        externalId,
        email,
        firstName: null,
        lastName: null,
        phone,
        sourceUpdatedAt: null,
        sourceCreatedAt: null,
      },
    ]);
    await identity.resolveMany(workspaceId, 'shopify', [externalId]);
    const [row] = await db.client
      .select({ canonicalCustomerId: commerceCustomers.canonicalCustomerId })
      .from(commerceCustomers)
      .where(
        and(
          eq(commerceCustomers.workspaceId, workspaceId),
          eq(commerceCustomers.externalId, externalId),
        ),
      );
    return row.canonicalCustomerId!;
  }

  async function shopifyOrder(
    workspaceId: string,
    customerExternalId: string,
    externalId: string,
    sessionId: string | null,
  ) {
    const order: NormalizedOrder = {
      externalId,
      customerExternalId,
      totalPrice: '1500.00',
      sourceUpdatedAt: new Date('2026-11-24T11:00:00Z'),
      sourceCreatedAt: new Date('2026-11-24T11:00:00Z'),
      sourceCancelledAt: null,
      externalCheckoutSessionId: sessionId,
      lineItems: [],
      refunds: [],
      fulfillments: [],
    };
    await orders.upsertMany(workspaceId, shopifyId[workspaceId], 'shopify', [order]);
  }

  /** Delivers and processes one simulated ABANDONED_CHECKOUT; returns the session id and webhook row id. */
  async function checkout(
    workspaceId: string,
    user: Record<string, unknown>,
    sessionId = `sess_${randomUUID()}`,
  ) {
    const key = workspaceId === ws.a ? 'a' : 'b';
    const body = flexypeAbandonedCheckout(
      { store: { shopify_domain: shop[key] } },
      { session_id: sessionId, user },
    );
    const result = await ingest.ingest(
      workspaceId,
      'flexype',
      JSON.stringify(body),
      flexypeHeaders(secret[workspaceId], randomUUID()),
    );
    const webhookEventId = (result as { webhookEventId: string }).webhookEventId;
    const deadline = Date.now() + 15_000;
    for (;;) {
      await processor.processDue(undefined, { workspaceId });
      const [row] = await db.client
        .select()
        .from(integrationWebhookEvents)
        .where(eq(integrationWebhookEvents.id, webhookEventId));
      if (row?.status === 'processed') return { sessionId, row };
      if (row?.status === 'dead_letter' || Date.now() > deadline)
        throw new Error(`webhook event ended ${row?.status}: ${row?.error}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const session = async (sessionId: string) =>
    (
      await db.client
        .select()
        .from(checkoutSessions)
        .where(eq(checkoutSessions.externalSessionId, sessionId))
    )[0];
  const canonicalCount = async (workspaceId: string) =>
    Number(
      (
        await db.client
          .select({ n: sql<number>`count(*)` })
          .from(canonicalCustomers)
          .where(eq(canonicalCustomers.workspaceId, workspaceId))
      )[0].n,
    );

  it('links by exact email to an existing customer, keeps no identifiers on the link, clears the raw payload and emits the customer id', async () => {
    const customerId = await shopifyCustomer(ws.a, 'c-link', 'linked@example.com');
    const { sessionId, row } = await checkout(ws.a, {
      email: ' Linked@Example.com ',
      phone_with_dial_code: '+919811111111',
    });

    expect(await session(sessionId)).toMatchObject({
      canonicalCustomerId: customerId,
      email: null,
      phoneE164: null,
      stage: 'PAYMENT_INITIATED',
      itemCount: 2,
    });
    expect(row.payload).toBeNull();
    expect(
      emitted.find((e) => e.payload.checkoutSessionId === sessionId)?.payload.canonicalCustomerId,
    ).toBe(customerId);
  });

  it('never links by phone alone and never creates customers; unknown shoppers stay unlinked with minimized identifiers', async () => {
    await shopifyCustomer(ws.a, 'c-phone', 'phone.owner@example.com', '+91 98222 22222');
    const before = await canonicalCount(ws.a);

    const phoneOnly = await checkout(ws.a, { email: null, phone_with_dial_code: '+919822222222' });
    const unknown = await checkout(ws.a, {
      email: 'stranger@example.com',
      phone_with_dial_code: '+919833333333',
    });

    expect(await session(phoneOnly.sessionId)).toMatchObject({
      canonicalCustomerId: null,
      email: null,
      phoneE164: '+919822222222',
    });
    expect(await session(unknown.sessionId)).toMatchObject({
      canonicalCustomerId: null,
      email: 'stranger@example.com',
      phoneE164: '+919833333333',
    });
    expect(await canonicalCount(ws.a)).toBe(before);
  });

  it('a merged customer resolves to its survivor', async () => {
    const [survivor] = await db.client
      .insert(canonicalCustomers)
      .values({ workspaceId: ws.a, primaryEmail: 'survivor@example.com' })
      .returning();
    await db.client.insert(canonicalCustomers).values({
      workspaceId: ws.a,
      primaryEmail: 'merged.away@example.com',
      mergedIntoId: survivor.id,
      mergedAt: new Date(),
    });

    const { sessionId } = await checkout(ws.a, { email: 'merged.away@example.com' });

    expect((await session(sessionId)).canonicalCustomerId).toBe(survivor.id);
  });

  it('records one row per provider session: a redelivered session (new event id) adds nothing and emits nothing', async () => {
    const sessionId = `sess_${randomUUID()}`;
    await checkout(ws.a, { email: 'stranger@example.com' }, sessionId);
    const emittedBefore = emitted.length;
    await checkout(ws.a, { email: 'stranger@example.com' }, sessionId);

    expect(
      await db.client
        .select()
        .from(checkoutSessions)
        .where(eq(checkoutSessions.externalSessionId, sessionId)),
    ).toHaveLength(1);
    expect(emitted.length).toBe(emittedBefore);
  });

  it('activity history shows linked sessions and sessions correlated by the Shopify "FlexyPe Session ID", with the later order, no amounts', async () => {
    const customerId = await shopifyCustomer(ws.a, 'c-activity', 'activity@example.com');
    const linked = await checkout(ws.a, { email: 'activity@example.com' });
    // Abandoned under another email, then completed by this customer: correlated only through the order's session id.
    const recovered = await checkout(ws.a, { email: 'someone.new@example.com' });
    await shopifyOrder(ws.a, 'c-activity', 'order-recovered', recovered.sessionId);
    const unrelated = await checkout(ws.a, { email: 'unrelated@example.com' });

    const entries = (await ucir.getActivity(ws.a, customerId)).filter(
      (entry) => entry.type === 'checkout_abandoned',
    );

    expect(entries.map((e) => (e as { externalId: string }).externalId).sort()).toEqual(
      [linked.sessionId, recovered.sessionId].sort(),
    );
    expect(
      entries.find((e) => (e as { externalId: string }).externalId === recovered.sessionId),
    ).toMatchObject({
      provider: 'flexype',
      stage: 'PAYMENT_INITIATED',
      completedOrderExternalId: 'order-recovered',
      attribution: 'order',
    });
    expect(
      entries.find((e) => (e as { externalId: string }).externalId === linked.sessionId),
    ).toMatchObject({ completedOrderExternalId: null, attribution: 'email' });
    // AI consumers only ever see the order-corroborated one.
    const aiView = withoutUnverifiedCheckouts(await ucir.getActivity(ws.a, customerId)).filter(
      (e) => e.type === 'checkout_abandoned',
    );
    expect(aiView.map((e) => (e as { externalId: string }).externalId)).toEqual([
      recovered.sessionId,
    ]);
    expect(JSON.stringify(entries)).not.toContain(unrelated.sessionId);
    expect(JSON.stringify(entries)).not.toMatch(/1500|1998|total/i);
    // The Shopify order is the only order: FlexyPe created none.
    expect(
      await db.client.select().from(commerceOrders).where(eq(commerceOrders.workspaceId, ws.a)),
    ).toHaveLength(1);
  });

  it("tenant isolation: an email known only in another workspace never links, and another workspace's order never correlates", async () => {
    const otherCustomer = await shopifyCustomer(ws.b, 'c-b', 'only.in.b@example.com');
    const inA = await checkout(ws.a, { email: 'only.in.b@example.com' });
    await shopifyOrder(ws.b, 'c-b', 'order-b', inA.sessionId);

    expect((await session(inA.sessionId)).canonicalCustomerId).toBeNull();
    const activityB = await ucir.getActivity(ws.b, otherCustomer);
    expect(activityB.some((entry) => entry.type === 'checkout_abandoned')).toBe(false);
    // Daily maintenance links within the session's own workspace only.
    await applyCheckoutSessionRetention(db.client, new Date(), 30);
    expect((await session(inA.sessionId)).canonicalCustomerId).toBeNull();
  });

  it('daily maintenance: late-links an unlinked session once its customer exists; anonymizes sessions unlinked past the window', async () => {
    const early = await checkout(ws.a, {
      email: 'later.customer@example.com',
      phone_with_dial_code: '+919844444444',
    });
    const stale = await checkout(ws.a, {
      email: 'never.customer@example.com',
      phone_with_dial_code: '+919855555555',
    });
    await db.client
      .update(checkoutSessions)
      .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(checkoutSessions.externalSessionId, stale.sessionId));
    const customerId = await shopifyCustomer(ws.a, 'c-later', 'later.customer@example.com');

    await applyCheckoutSessionRetention(db.client, new Date(), 30);

    expect(await session(early.sessionId)).toMatchObject({
      canonicalCustomerId: customerId,
      email: null,
      phoneE164: null,
    });
    expect(await session(stale.sessionId)).toMatchObject({
      canonicalCustomerId: null,
      email: null,
      phoneE164: null,
      stage: 'PAYMENT_INITIATED',
    });
  });

  it("erasure removes the person's linked and unlinked checkout sessions (email or phone), blocks the erased email afterwards, and spares others", async () => {
    const erasure = moduleRef.get(CustomerErasureService);
    const customerId = await shopifyCustomer(
      ws.a,
      'c-erase',
      'erase.me@example.com',
      '+91 98666 66666',
    );
    const linked = await checkout(ws.a, { email: 'erase.me@example.com' });
    const byPhone = await checkout(ws.a, { email: null, phone_with_dial_code: '+919866666666' });
    const other = await checkout(ws.a, {
      email: 'keep.me@example.com',
      phone_with_dial_code: '+919877777777',
    });

    await erasure.eraseCanonicalCustomer(ws.a, customerId, 'clerk_spec_owner');

    expect(await session(linked.sessionId)).toBeUndefined();
    expect(await session(byPhone.sessionId)).toBeUndefined();
    expect(await session(other.sessionId)).toMatchObject({ email: 'keep.me@example.com' });

    const after = await checkout(ws.a, {
      email: 'erase.me@example.com',
      phone_with_dial_code: '+919866666666',
    });
    expect(await session(after.sessionId)).toMatchObject({
      canonicalCustomerId: null,
      email: null,
      phoneE164: null,
    });
  });

  it('Shopify customers/redact of a source customer removes unlinked checkout sessions carrying their email or phone', async () => {
    await shopifyCustomer(ws.b, 'c-redact', 'redact.me@example.com', '+91 98888 88888');
    // Phone-only checkout: never linked by phone, so it stays unlinked and carries the phone.
    const byPhone = await checkout(ws.b, { email: null, phone_with_dial_code: '+919888888888' });

    const result = await integrationService.purgeCommerceCustomer(
      ws.b,
      shopifyId[ws.b],
      'c-redact',
    );

    expect(result.found).toBe(true);
    expect(await session(byPhone.sessionId)).toBeUndefined();
  });
  it('erasure also removes an unlinked session tied to the person only through their own order session id', async () => {
    const erasure = moduleRef.get(CustomerErasureService);
    const customerId = await shopifyCustomer(ws.a, 'c-erase-order', 'erase.by.order@example.com');
    const typedOtherEmail = await checkout(ws.a, {
      email: 'typed.differently@example.com',
      phone_with_dial_code: null,
    });
    await shopifyOrder(ws.a, 'c-erase-order', 'order-erase-by-session', typedOtherEmail.sessionId);

    await erasure.eraseCanonicalCustomer(ws.a, customerId, 'clerk_spec_owner');

    expect(await session(typedOtherEmail.sessionId)).toBeUndefined();
  });

  it('retention also clears a stale checkout delivery that never finished processing (no copy outlives the window)', async () => {
    const flexypeId = (await integrationService.listByWorkspace(ws.a)).find(
      (i) => i.provider === 'flexype',
    )!.id;
    const old = new Date(Date.now() - 31 * 86_400_000);
    const [stale] = await db.client
      .insert(integrationWebhookEvents)
      .values({
        workspaceId: ws.a,
        integrationId: flexypeId,
        externalEventId: `stale-${randomUUID()}`,
        eventType: 'ABANDONED_CHECKOUT',
        status: 'dead_letter',
        payload: {
          resource: 'checkout',
          data: { email: 'stuck@example.com', phone: '+919899999999' },
        },
        createdAt: old,
      })
      .returning();
    const [fresh] = await db.client
      .insert(integrationWebhookEvents)
      .values({
        workspaceId: ws.a,
        integrationId: flexypeId,
        externalEventId: `fresh-${randomUUID()}`,
        eventType: 'ABANDONED_CHECKOUT',
        status: 'dead_letter',
        payload: { resource: 'checkout', data: { email: 'recent@example.com' } },
      })
      .returning();

    await applyCheckoutSessionRetention(db.client, new Date(), 30);

    const rows = await db.client
      .select()
      .from(integrationWebhookEvents)
      .where(inArray(integrationWebhookEvents.id, [stale.id, fresh.id]));
    expect(rows.find((r) => r.id === stale.id)).toMatchObject({
      payload: null,
      status: 'processed',
    });
    expect(rows.find((r) => r.id === fresh.id)).toMatchObject({ status: 'dead_letter' });
  });
  it('record retention: deletes unlinked sessions past the record window unless an order carries the session id; keeps linked ones', async () => {
    const customerId = await shopifyCustomer(ws.a, 'c-record', 'record.keep@example.com');
    const uncorrelated = await checkout(ws.a, { email: 'nobody.record@example.com' });
    const correlated = await checkout(ws.a, { email: 'other.typed@example.com' });
    await shopifyOrder(ws.a, 'c-record', 'order-record', correlated.sessionId);
    const linked = await checkout(ws.a, { email: 'record.keep@example.com' });
    const recent = await checkout(ws.a, { email: 'recent.record@example.com' });
    const old = new Date(Date.now() - 91 * 86_400_000);
    await db.client
      .update(checkoutSessions)
      .set({ createdAt: old })
      .where(
        inArray(checkoutSessions.externalSessionId, [
          uncorrelated.sessionId,
          correlated.sessionId,
          linked.sessionId,
        ]),
      );

    const result = await applyCheckoutSessionRetention(db.client, new Date(), 30, 90);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await session(uncorrelated.sessionId)).toBeUndefined();
    expect(await session(correlated.sessionId)).toMatchObject({
      canonicalCustomerId: null,
      email: null,
    });
    expect(await session(linked.sessionId)).toMatchObject({ canonicalCustomerId: customerId });
    expect(await session(recent.sessionId)).toMatchObject({ email: 'recent.record@example.com' });
  });
});
