import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';

vi.hoisted(() => {
  process.env.ERASURE_HMAC_SECRET = 'erasure-ingestion-block-test-secret-0123456789abcdef';
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
import { erasedCustomerIdentifiers } from '../../database/schema/erased-customer-identifiers';
import { CustomerService, type NormalizedCustomer } from '../commerce/customer.service';
import { OrderService, type NormalizedOrder } from '../commerce/order.service';
import { ErasedIdentifierService, emailIdentifier, orderIdentifier, sourceIdentifier } from '../commerce/erased-identifier.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { IntegrationService } from './integration.service';
import { WebhookEventProcessorService } from './webhook-event-processor.service';
import { upsertGuestCustomers } from './guest-customers';
import { WooCommerceAdapter } from './providers/woocommerce/woocommerce.adapter';

/**
 * Erasure Slice 3: identifiers on the block list never come back through customer upserts, guest orders or order
 * upserts, only in the workspace that erased them; a webhook row whose payload an erasure cleared is completed as a
 * no-op. The block list is seeded directly here — the erasure itself is covered by customer-erasure.db.spec.
 */
describe('Erased identifiers block ingestion (real DB)', { timeout: 90_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let customers: CustomerService;
  let orders: OrderService;
  const wsA = randomUUID();
  const wsB = randomUUID();
  const integrationIds: Record<string, string> = {};

  const customer = (externalId: string, email: string | null): NormalizedCustomer => ({
    externalId,
    email,
    firstName: 'Era',
    lastName: 'Sed',
    phone: null,
    sourceUpdatedAt: null,
    sourceCreatedAt: null,
  });
  const order = (externalId: string, customerExternalId: string | null): NormalizedOrder => ({
    externalId,
    customerExternalId,
    totalPrice: '10.00',
    sourceUpdatedAt: new Date('2026-05-01T00:00:00Z'),
    sourceCreatedAt: new Date('2026-05-01T00:00:00Z'),
    lineItems: [{ externalId: `${externalId}-1`, variantExternalId: null, quantity: 1, price: '10.00' }],
    refunds: [],
    fulfillments: [],
  });
  const sourceRows = (ws: string) => db.client.select().from(commerceCustomers).where(eq(commerceCustomers.workspaceId, ws));
  const orderRow = async (ws: string, externalId: string) =>
    (await db.client.select().from(commerceOrders).where(and(eq(commerceOrders.workspaceId, ws), eq(commerceOrders.externalId, externalId))))[0];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    customers = moduleRef.get(CustomerService);
    orders = moduleRef.get(OrderService);
    await db.client.insert(workspaces).values([
      { id: wsA, name: 'Erasure Ingestion Block Test A' },
      { id: wsB, name: 'Erasure Ingestion Block Test B' },
    ]);
    const integrationService = moduleRef.get(IntegrationService);
    for (const ws of [wsA, wsB]) integrationIds[ws] = (await integrationService.connect(ws, 'woocommerce')).id;

    // wsA erased: WooCommerce customer 7, email gone@example.com, order 900.
    await db.transaction((tx) =>
      moduleRef.get(ErasedIdentifierService).record(tx, wsA, [sourceIdentifier('woocommerce', '7'), emailIdentifier('gone@example.com')!, orderIdentifier('woocommerce', '900')]),
    );
  }, 90_000);

  afterAll(async () => {
    if (db?.isConfigured()) {
      const ids = [wsA, wsB];
      await db.client.delete(commerceOrderLineItems).where(inArray(commerceOrderLineItems.workspaceId, ids));
      await db.client.delete(commerceOrders).where(inArray(commerceOrders.workspaceId, ids));
      await db.client.delete(integrationWebhookEvents).where(inArray(integrationWebhookEvents.workspaceId, ids));
      await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
      await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
      await db.client.delete(erasedCustomerIdentifiers).where(inArray(erasedCustomerIdentifiers.workspaceId, ids));
      await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
      await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    }
    await moduleRef?.close();
  }, 90_000);

  it('customer upserts drop erased customers by provider id or email (any case); others are written', async () => {
    const written = await customers.upsertMany(wsA, integrationIds[wsA], 'woocommerce', [
      customer('7', 'new-address@example.com'), // erased id, new email
      customer('8', '  GONE@Example.com '), // new id, erased email
      customer('9', 'kept@example.com'),
    ]);

    expect(written).toBe(1);
    expect((await sourceRows(wsA)).map((row) => row.externalId)).toEqual(['9']);
  });

  it('guest orders with an erased email create no guest customer and stay unlinked', async () => {
    const adapter = moduleRef.get(WooCommerceAdapter);
    const guestOrder = (adapter.parseWebhookEvent(
      JSON.stringify({ id: 950, customer_id: 0, total: '5.00', line_items: [], billing: { email: 'gone@example.com', first_name: 'Gone' } }),
      { 'x-wc-webhook-topic': 'order.created' },
    )!.payload as { data: NormalizedOrder }).data;

    await upsertGuestCustomers(customers, moduleRef.get(IdentityResolutionService), wsA, integrationIds[wsA], 'woocommerce', [guestOrder]);
    await orders.upsertMany(wsA, integrationIds[wsA], 'woocommerce', [guestOrder]);

    expect((await sourceRows(wsA)).some((row) => row.externalId === 'guest:gone@example.com')).toBe(false);
    expect((await orderRow(wsA, '950')).customerId).toBeNull();
  });

  it('order upserts skip erased orders and never link an erased customer', async () => {
    await customers.upsertMany(wsA, integrationIds[wsA], 'woocommerce', [customer('9', 'kept@example.com')]);

    const result = await orders.upsertMany(wsA, integrationIds[wsA], 'woocommerce', [order('900', '9'), order('901', '7'), order('902', '9')]);

    expect(result.ordersWritten).toBe(2);
    expect(await orderRow(wsA, '900')).toBeUndefined();
    expect((await orderRow(wsA, '901')).customerId).toBeNull();
    const kept = (await sourceRows(wsA)).find((row) => row.externalId === '9')!;
    expect((await orderRow(wsA, '902')).customerId).toBe(kept.id);
  });

  it('another workspace is not affected by this workspace’s erasures', async () => {
    await customers.upsertMany(wsB, integrationIds[wsB], 'woocommerce', [customer('7', 'gone@example.com')]);
    await orders.upsertMany(wsB, integrationIds[wsB], 'woocommerce', [order('900', '7')]);

    expect((await sourceRows(wsB)).map((row) => row.externalId)).toEqual(['7']);
    expect((await orderRow(wsB, '900')).customerId).not.toBeNull();
  });

  it('a pending webhook row whose payload an erasure cleared completes as a no-op instead of dead-lettering', async () => {
    const [row] = await db.client
      .insert(integrationWebhookEvents)
      .values({ workspaceId: wsA, integrationId: integrationIds[wsA], externalEventId: randomUUID(), eventType: 'customer.updated', status: 'pending', payload: null })
      .returning();

    expect(await moduleRef.get(WebhookEventProcessorService).processEvent(row.id)).toBe(true);

    const [after] = await db.client.select().from(integrationWebhookEvents).where(eq(integrationWebhookEvents.id, row.id));
    expect(after).toMatchObject({ status: 'processed', error: null, payload: null });
  });
});
