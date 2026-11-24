import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';

vi.hoisted(() => {
  process.env.ERASURE_HMAC_SECRET = 'flexype-webhook-spec-secret-0123456789abcdef';
});

import { AppModule } from '../../../../app.module';
import { DatabaseService } from '../../../../database/database.service';
import { workspaces } from '../../../../database/schema/workspaces';
import { integrations } from '../../../../database/schema/integrations';
import { integrationWebhookEvents } from '../../../../database/schema/integration-webhook-events';
import { commerceCustomers } from '../../../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../../../database/schema/canonical-customers';
import { canonicalCustomerDuplicates } from '../../../../database/schema/canonical-customer-duplicates';
import { customerErasures } from '../../../../database/schema/customer-erasures';
import { erasedCustomerIdentifiers } from '../../../../database/schema/erased-customer-identifiers';
import {
  NotFoundError,
  UnauthenticatedError,
  UnauthorizedError,
  ValidationError,
} from '../../../../common/errors/app-error';
import type { DomainEvent } from '../../../../common/events/domain-event';
import { EventBus } from '../../../../common/events/event-bus.service';
import { CustomerService } from '../../../commerce/customer.service';
import { IdentityResolutionService } from '../../../identity-resolution/identity-resolution.service';
import { IntegrationService } from '../../integration.service';
import { WebhookIngestService } from '../../webhook-ingest.service';
import {
  WebhookEventProcessorService,
  type CheckoutAbandonedPayload,
} from '../../webhook-event-processor.service';
import { CustomerErasureService } from '../../customer-erasure.service';
import { FlexyPeWebhookSetupService } from './flexype-webhook-setup.service';
import { flexypeAbandonedCheckout, flexypeHeaders } from './flexype.test-fixtures';

/**
 * FlexyPe webhook intake against the real dev DB with simulated 2026-05 deliveries (no real FlexyPe account, no
 * merchant data): secret setup, authentication, X-Event-Id dedup, store/workspace binding, minimized storage,
 * `checkout.abandoned` emission without personal data, erasure coverage. Throwaway workspaces, deleted in afterAll.
 */
describe('FlexyPe webhook intake (real DB)', { timeout: 90_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let setup: FlexyPeWebhookSetupService;
  let integrationService: IntegrationService;
  let ingest: WebhookIngestService;
  let processor: WebhookEventProcessorService;
  const emitted: DomainEvent<CheckoutAbandonedPayload>[] = [];
  const ws = { a: randomUUID(), b: randomUUID(), noShop: randomUUID() };
  const shop = { a: 'flexype-spec-a.myshopify.com', b: 'flexype-spec-b.myshopify.com' };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error(
        'DATABASE_URL is not configured — this integration test requires the real dev database.',
      );
    }
    setup = moduleRef.get(FlexyPeWebhookSetupService);
    integrationService = moduleRef.get(IntegrationService);
    ingest = moduleRef.get(WebhookIngestService);
    processor = moduleRef.get(WebhookEventProcessorService);
    const bus = moduleRef.get(EventBus);
    const emit = bus.emit.bind(bus);
    vi.spyOn(bus, 'emit').mockImplementation((event: DomainEvent) => {
      if (event.type === 'checkout.abandoned')
        emitted.push(event as DomainEvent<CheckoutAbandonedPayload>);
      return emit(event);
    });

    await db.client.insert(workspaces).values([
      { id: ws.a, name: 'FlexyPe Spec A' },
      { id: ws.b, name: 'FlexyPe Spec B' },
      { id: ws.noShop, name: 'FlexyPe Spec No Shopify' },
    ]);
    for (const [id, domain] of [
      [ws.a, shop.a],
      [ws.b, shop.b],
    ] as const) {
      await integrationService.connect(id, 'shopify');
      // Stored directly: a real Shopify connect needs a real store. shopDomain fills integrations.shop_domain.
      await integrationService.setCredentials(id, 'shopify', {
        shopDomain: domain,
        accessToken: 'shpat_test',
      });
    }
    for (const id of Object.values(ws)) {
      await integrationService.connect(id, 'flexype');
    }
  }, 90_000);

  afterAll(async () => {
    if (db?.isConfigured()) {
      const ids = Object.values(ws);
      await db.client
        .delete(integrationWebhookEvents)
        .where(inArray(integrationWebhookEvents.workspaceId, ids));
      await db.client.delete(customerErasures).where(inArray(customerErasures.workspaceId, ids));
      await db.client
        .delete(erasedCustomerIdentifiers)
        .where(inArray(erasedCustomerIdentifiers.workspaceId, ids));
      await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
      await db.client
        .delete(canonicalCustomerDuplicates)
        .where(inArray(canonicalCustomerDuplicates.workspaceId, ids));
      await db.client
        .delete(canonicalCustomers)
        .where(inArray(canonicalCustomers.workspaceId, ids));
      await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
      await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    }
    vi.restoreAllMocks();
    await moduleRef?.close();
  }, 90_000);

  const deliver = (workspaceId: string, secret: string, body: unknown, eventId = randomUUID()) =>
    ingest.ingest(workspaceId, 'flexype', JSON.stringify(body), flexypeHeaders(secret, eventId));

  const rowsFor = (workspaceId: string) =>
    db.client
      .select()
      .from(integrationWebhookEvents)
      .where(eq(integrationWebhookEvents.workspaceId, workspaceId));

  async function waitProcessed(workspaceId: string, webhookEventId: string) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      await processor.processDue(undefined, { workspaceId });
      const [row] = await db.client
        .select()
        .from(integrationWebhookEvents)
        .where(eq(integrationWebhookEvents.id, webhookEventId));
      if (row?.status === 'processed') return row;
      if (Date.now() > deadline) throw new Error(`webhook event stayed ${row?.status}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('settings show URL, version and event types but never the secret; the secret is stored encrypted and returned once', async () => {
    expect(await setup.getSettings(ws.a)).toEqual({
      webhookUrl: expect.stringMatching(
        new RegExp(`/api/v1/workspaces/${ws.a}/integrations/flexype/webhooks$`),
      ),
      webhookVersion: '2026-05',
      eventTypes: ['ABANDONED_CHECKOUT'],
      secretConfigured: false,
    });

    const { webhookSecret } = await setup.generateSecret(ws.a);
    expect(webhookSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored] = await db.client
      .select({ credentials: integrations.credentials, shopDomain: integrations.shopDomain })
      .from(integrations)
      .where(
        eq(
          integrations.id,
          (await integrationService.listByWorkspace(ws.a)).find((i) => i.provider === 'flexype')!
            .id,
        ),
      );
    expect(JSON.stringify(stored.credentials)).not.toContain(webhookSecret);
    expect(stored.shopDomain).toBeNull();
    const settings = await setup.getSettings(ws.a);
    expect(settings.secretConfigured).toBe(true);
    expect(settings).not.toHaveProperty('webhookSecret');
  });

  it('accepts an authenticated delivery for the workspace store, stores it minimized, dedups retries by X-Event-Id and emits checkout.abandoned without personal data', async () => {
    const { webhookSecret } = await setup.generateSecret(ws.a);
    const eventId = randomUUID();
    const body = flexypeAbandonedCheckout(
      { store: { shopify_domain: 'FLEXYPE-SPEC-A.myshopify.com' } },
      { session_id: `sess_${eventId}` },
    );

    const result = await deliver(ws.a, webhookSecret, body, eventId);
    expect(result.status).toBe('accepted');
    // FlexyPe retries carry the same X-Event-Id.
    expect(await deliver(ws.a, webhookSecret, body, eventId)).toEqual({ status: 'duplicate' });

    const row = await waitProcessed(ws.a, (result as { webhookEventId: string }).webhookEventId);
    expect(row.eventType).toBe('ABANDONED_CHECKOUT');
    expect(row.externalEventId).toBe(eventId);
    const stored = JSON.stringify(row.payload);
    expect(stored).toContain('shopper@example.com');
    for (const dropped of [
      '203.0.113.7',
      'Mozilla',
      'utm_source',
      'secret-token',
      'Test Shopper',
    ]) {
      expect(stored).not.toContain(dropped);
    }
    expect((await rowsFor(ws.a)).filter((r) => r.externalEventId === eventId)).toHaveLength(1);

    const event = emitted.find((e) => e.payload.checkoutSessionId === `sess_${eventId}`);
    expect(event).toMatchObject({
      type: 'checkout.abandoned',
      workspaceId: ws.a,
      payload: {
        stage: 'PAYMENT_INITIATED',
        currency: 'INR',
        itemCount: 2,
        occurredAt: '2026-11-24T10:15:00.000Z',
      },
    });
    expect(JSON.stringify(event)).not.toMatch(/shopper@example\.com|9876543210/);
    // Signal only: nothing written to commerce data.
    expect(
      await db.client
        .select()
        .from(commerceCustomers)
        .where(eq(commerceCustomers.workspaceId, ws.a)),
    ).toHaveLength(0);
  });

  it("rejects a wrong secret, another workspace's secret, a foreign store, and a workspace without a connected Shopify store — storing nothing", async () => {
    const { webhookSecret: secretA } = await setup.generateSecret(ws.a);
    const { webhookSecret: secretB } = await setup.generateSecret(ws.b);
    const { webhookSecret: secretNoShop } = await setup.generateSecret(ws.noShop);
    const before = (await rowsFor(ws.b)).length;

    await expect(
      deliver(
        ws.b,
        'not-the-secret',
        flexypeAbandonedCheckout({ store: { shopify_domain: shop.b } }),
      ),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(
      deliver(ws.b, secretA, flexypeAbandonedCheckout({ store: { shopify_domain: shop.b } })),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
    // Valid secret for B, but the checkout belongs to A's store → never attached to B.
    await expect(
      deliver(ws.b, secretB, flexypeAbandonedCheckout({ store: { shopify_domain: shop.a } })),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(
      deliver(
        ws.noShop,
        secretNoShop,
        flexypeAbandonedCheckout({ store: { shopify_domain: shop.a } }),
      ),
    ).rejects.toBeInstanceOf(UnauthorizedError);

    expect((await rowsFor(ws.b)).length).toBe(before);
    expect(await rowsFor(ws.noShop)).toHaveLength(0);
  });

  it('rejects an unsupported payload version and ignores event types BRAYN does not process', async () => {
    const { webhookSecret } = await setup.generateSecret(ws.b);
    const before = (await rowsFor(ws.b)).length;
    await expect(
      ingest.ingest(
        ws.b,
        'flexype',
        JSON.stringify(flexypeAbandonedCheckout({ store: { shopify_domain: shop.b } })),
        flexypeHeaders(webhookSecret, randomUUID(), '2025-09'),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      await deliver(
        ws.b,
        webhookSecret,
        flexypeAbandonedCheckout({
          event_type: 'PRODUCT_VIEWED',
          store: { shopify_domain: shop.b },
        }),
      ),
    ).toEqual({ status: 'ignored' });
    expect((await rowsFor(ws.b)).length).toBe(before);
  });

  it('refuses secret generation until FlexyPe is connected, and disconnect clears the secret', async () => {
    const wsC = randomUUID();
    await db.client.insert(workspaces).values({ id: wsC, name: 'FlexyPe Spec C' });
    try {
      await expect(setup.generateSecret(wsC)).rejects.toBeInstanceOf(NotFoundError);
    } finally {
      await db.client.delete(workspaces).where(eq(workspaces.id, wsC));
    }
    await setup.generateSecret(ws.noShop);
    await integrationService.disconnect(ws.noShop, 'flexype');
    expect(await setup.getSettings(ws.noShop)).toMatchObject({ secretConfigured: false });
    await expect(setup.generateSecret(ws.noShop)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("customer erasure clears checkout signals carrying the person's email or phone, and leaves other shoppers' signals", async () => {
    const customers = moduleRef.get(CustomerService);
    const identity = moduleRef.get(IdentityResolutionService);
    const erasure = moduleRef.get(CustomerErasureService);
    const shopifyId = (await integrationService.listByWorkspace(ws.a)).find(
      (i) => i.provider === 'shopify',
    )!.id;
    await customers.upsertMany(ws.a, shopifyId, 'shopify', [
      {
        externalId: 'gid-erase-1',
        email: 'erase.me@example.com',
        firstName: null,
        lastName: null,
        phone: '+91 91234 56789',
        sourceUpdatedAt: null,
        sourceCreatedAt: null,
      },
    ]);
    await identity.resolveMany(ws.a, 'shopify', ['gid-erase-1']);
    const [source] = await db.client
      .select()
      .from(commerceCustomers)
      .where(eq(commerceCustomers.externalId, 'gid-erase-1'));

    const { webhookSecret } = await setup.generateSecret(ws.a);
    const user = (email: string | null, phone: string | null) => ({
      email,
      phone_with_dial_code: phone,
    });
    const byEmail = await deliver(
      ws.a,
      webhookSecret,
      flexypeAbandonedCheckout(
        { store: { shopify_domain: shop.a } },
        { user: user('Erase.Me@example.com', null) },
      ),
    );
    const byPhone = await deliver(
      ws.a,
      webhookSecret,
      flexypeAbandonedCheckout(
        { store: { shopify_domain: shop.a } },
        { user: user(null, '+919123456789') },
      ),
    );
    const other = await deliver(
      ws.a,
      webhookSecret,
      flexypeAbandonedCheckout(
        { store: { shopify_domain: shop.a } },
        { user: user('someone.else@example.com', '+919000000000') },
      ),
    );
    const ids = [byEmail, byPhone, other].map(
      (r) => (r as { webhookEventId: string }).webhookEventId,
    );
    for (const id of ids) await waitProcessed(ws.a, id);

    await erasure.eraseCanonicalCustomer(ws.a, source.canonicalCustomerId!, 'clerk_spec_owner');

    const rows = await db.client
      .select()
      .from(integrationWebhookEvents)
      .where(inArray(integrationWebhookEvents.id, ids));
    const payloadOf = (id: string) => rows.find((r) => r.id === id)!.payload;
    expect(payloadOf(ids[0])).toBeNull();
    expect(payloadOf(ids[1])).toBeNull();
    expect(JSON.stringify(payloadOf(ids[2]))).toContain('someone.else@example.com');
  });
});
