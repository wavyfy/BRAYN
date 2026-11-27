import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray } from 'drizzle-orm';
import { AppModule } from '../../../../app.module';
import { DatabaseService } from '../../../../database/database.service';
import { workspaces } from '../../../../database/schema/workspaces';
import { integrations } from '../../../../database/schema/integrations';
import { integrationWebhookEvents } from '../../../../database/schema/integration-webhook-events';
import { commerceCustomers } from '../../../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../../../database/schema/canonical-customers';
import { EventBus } from '../../../../common/events/event-bus.service';
import { IntegrationService } from '../../integration.service';
import { WebhookIngestService } from '../../webhook-ingest.service';
import { WebhookEventProcessorService } from '../../webhook-event-processor.service';
import { CustomerService } from '../../../commerce/customer.service';
import {
  applyCompliancePayloadRetention,
  complianceOpenIssueCounts,
} from './shopify-compliance-retention';
import type { Env } from '../../../../config/env.schema';

/**
 * Shopify business-webhook hardening against the real dev DB:
 * D2 — authentication before side effects (no credential refresh from a webhook, signed or not);
 * D3 — a delivery whose shop isn't the integration's store (or a recorded alias) is quarantined, never processed;
 * D1 — customer upserts are newer-or-equal-only and never clear a field the source omitted.
 */
describe('Shopify business webhook hardening (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let integrationService: IntegrationService;
  let ingest: WebhookIngestService;
  let processor: WebhookEventProcessorService;
  let customers: CustomerService;
  let eventBus: EventBus;
  let appSecret: string;
  const workspaceIds: string[] = [];

  const sign = (body: string) =>
    createHmac('sha256', appSecret).update(body, 'utf8').digest('base64');
  const newShop = () => `hardening-${randomUUID().slice(0, 8)}.myshopify.com`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured())
      throw new Error(
        'DATABASE_URL is not configured — this integration test requires the real dev database.',
      );
    const secret = moduleRef
      .get(ConfigService<Env, true>)
      .get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    if (!secret)
      throw new Error(
        'SHOPIFY_APP_CLIENT_SECRET is not configured — this test signs deliveries with the app secret.',
      );
    appSecret = secret;
    integrationService = moduleRef.get(IntegrationService);
    ingest = moduleRef.get(WebhookIngestService);
    processor = moduleRef.get(WebhookEventProcessorService);
    customers = moduleRef.get(CustomerService);
    eventBus = moduleRef.get(EventBus);
  }, 60_000);

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    if (db?.isConfigured() && workspaceIds.length > 0) {
      await db.client
        .delete(integrationWebhookEvents)
        .where(inArray(integrationWebhookEvents.workspaceId, workspaceIds));
      await db.client
        .delete(commerceCustomers)
        .where(inArray(commerceCustomers.workspaceId, workspaceIds));
      await db.client
        .delete(canonicalCustomers)
        .where(inArray(canonicalCustomers.workspaceId, workspaceIds));
      await db.client.delete(integrations).where(inArray(integrations.workspaceId, workspaceIds));
      await db.client.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
    }
    await moduleRef?.close();
  }, 60_000);

  /** A workspace whose Shopify store is `shop`, connected like OAuth does — no per-store webhookSecret, expired token. */
  async function store(shop: string) {
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    await db.client.insert(workspaces).values({ id: workspaceId, name: 'Webhook hardening spec' });
    expect(
      await integrationService.connectStore(workspaceId, 'shopify', {
        shopDomain: shop,
        accessToken: 'shpat_expired',
        refreshToken: 'shprt_test',
        grantType: 'authorization_code',
        expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    ).toBe('ok');
    const [row] = await db.client
      .select()
      .from(integrations)
      .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'shopify')));
    return { workspaceId, integration: row };
  }

  function customerDelivery(shopHeader: string | undefined, customer: Record<string, unknown>) {
    const body = JSON.stringify(customer);
    const headers: Record<string, string> = {
      'x-shopify-topic': 'customers/update',
      'x-shopify-hmac-sha256': sign(body),
      'x-shopify-webhook-id': randomUUID(),
    };
    if (shopHeader !== undefined) headers['x-shopify-shop-domain'] = shopHeader;
    return { body, headers };
  }

  /** Ingest without the async wake-up, then process synchronously (this workspace only). */
  async function deliver(
    workspaceId: string,
    d: { body: string; headers: Record<string, string> },
  ) {
    vi.spyOn(eventBus, 'emit').mockImplementationOnce(() => undefined);
    const result = await ingest.ingest(workspaceId, 'shopify', d.body, d.headers);
    await processor.processDue(10, { workspaceId });
    return result;
  }

  const customerRow = async (workspaceId: string, externalId: string) =>
    (
      await db.client
        .select()
        .from(commerceCustomers)
        .where(
          and(
            eq(commerceCustomers.workspaceId, workspaceId),
            eq(commerceCustomers.externalId, externalId),
          ),
        )
    )[0];

  const credentialOf = async (workspaceId: string) =>
    (
      await db.client
        .select({ c: integrations.credentials })
        .from(integrations)
        .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'shopify')))
    )[0].c;

  describe('D2 — authentication before side effects', () => {
    it('an unsigned / wrongly signed delivery is rejected with no Shopify call, no credential change and no row', async () => {
      const shop = newShop();
      const { workspaceId } = await store(shop);
      const fetchSpy = vi.fn(async () => new Response('should not be called', { status: 500 }));
      vi.stubGlobal('fetch', fetchSpy);
      const before = await credentialOf(workspaceId);

      const d = customerDelivery(shop, {
        id: 1,
        email: 'a@x.com',
        updated_at: '2026-01-01T00:00:00Z',
      });
      const attempts: Record<string, string>[] = [
        { ...d.headers, 'x-shopify-hmac-sha256': 'bm9wZQ==' },
        { 'x-shopify-topic': 'customers/update', 'x-shopify-shop-domain': shop },
      ];
      for (const headers of attempts) {
        await expect(ingest.ingest(workspaceId, 'shopify', d.body, headers)).rejects.toMatchObject({
          code: 'UNAUTHENTICATED',
        });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await credentialOf(workspaceId)).toBe(before);
      expect(
        await db.client
          .select()
          .from(integrationWebhookEvents)
          .where(eq(integrationWebhookEvents.workspaceId, workspaceId)),
      ).toHaveLength(0);
    });

    it('a valid delivery for an integration with an EXPIRED token is processed without refreshing (no rotation from a webhook)', async () => {
      const shop = newShop();
      const { workspaceId } = await store(shop);
      const fetchSpy = vi.fn(async () => new Response('should not be called', { status: 500 }));
      vi.stubGlobal('fetch', fetchSpy);
      const before = await credentialOf(workspaceId);

      expect(
        await deliver(
          workspaceId,
          customerDelivery(shop, {
            id: 11,
            email: 'eleven@x.com',
            updated_at: '2026-01-01T00:00:00Z',
          }),
        ),
      ).toMatchObject({ status: 'accepted' });
      expect((await customerRow(workspaceId, '11'))?.email).toBe('eleven@x.com');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await credentialOf(workspaceId)).toBe(before);
    });

    it('a malformed body or an unsupported topic fails safely (ignored, nothing processed)', async () => {
      const shop = newShop();
      const { workspaceId } = await store(shop);
      for (const [topic, body] of [
        ['customers/update', '{not json'],
        ['themes/update', '{}'],
      ]) {
        const headers = {
          'x-shopify-topic': topic,
          'x-shopify-shop-domain': shop,
          'x-shopify-hmac-sha256': sign(body),
          'x-shopify-webhook-id': randomUUID(),
        };
        await expect(ingest.ingest(workspaceId, 'shopify', body, headers)).resolves.toEqual({
          status: 'ignored',
        });
      }
      expect(
        await db.client
          .select()
          .from(integrationWebhookEvents)
          .where(eq(integrationWebhookEvents.workspaceId, workspaceId)),
      ).toHaveLength(0);
    });
  });

  describe('D3 — store isolation', () => {
    it('a validly signed delivery naming another shop is quarantined: no customer written, alerted, releasable after an alias is confirmed', async () => {
      const [shopA, shopB] = [newShop(), newShop()];
      const a = await store(shopA);
      const b = await store(shopB);
      const quarantinedBefore = (await complianceOpenIssueCounts(db.client, new Date()))
        .quarantinedWebhooks;

      // A delivery for store B arriving at A's URL (e.g. a lingering subscription).
      const result = await deliver(
        a.workspaceId,
        customerDelivery(shopB, {
          id: 21,
          email: 'b-customer@x.com',
          updated_at: '2026-01-01T00:00:00Z',
        }),
      );
      expect(result).toMatchObject({ status: 'quarantined' });
      expect(await customerRow(a.workspaceId, '21')).toBeUndefined();
      expect(await customerRow(b.workspaceId, '21')).toBeUndefined();
      const [row] = await db.client
        .select()
        .from(integrationWebhookEvents)
        .where(eq(integrationWebhookEvents.workspaceId, a.workspaceId));
      expect(row).toMatchObject({
        status: 'quarantined',
        error: `store_mismatch: received ${shopB}`,
      });
      expect(
        (await complianceOpenIssueCounts(db.client, new Date())).quarantinedWebhooks,
      ).toBeGreaterThan(quarantinedBefore);

      // Missing header → quarantined too.
      expect(
        await deliver(
          a.workspaceId,
          customerDelivery(undefined, {
            id: 22,
            email: 'x@x.com',
            updated_at: '2026-01-01T00:00:00Z',
          }),
        ),
      ).toMatchObject({ status: 'quarantined' });

      // Operator confirms the domain is A's alias (legacy/renamed store), then releases the held delivery.
      expect(await integrationService.addShopDomainAlias(a.workspaceId, shopB.toUpperCase())).toBe(
        true,
      );
      await ingest.releaseQuarantined(row.id);
      await processor.processDue(10, { workspaceId: a.workspaceId });
      expect((await customerRow(a.workspaceId, '21'))?.email).toBe('b-customer@x.com');
      // …and later deliveries under that alias are accepted directly.
      expect(
        await deliver(
          a.workspaceId,
          customerDelivery(shopB, { id: 23, email: 'y@x.com', updated_at: '2026-01-01T00:00:00Z' }),
        ),
      ).toMatchObject({ status: 'accepted' });
      await expect(ingest.releaseQuarantined(row.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('a legacy integration (BIBA-like: no shop id) keeps working for its stored domain, case-insensitively', async () => {
      const shop = newShop();
      const { workspaceId, integration } = await store(shop);
      expect(integration.shopifyShopId).toBeNull();
      expect(
        await deliver(
          workspaceId,
          customerDelivery(shop.toUpperCase(), {
            id: 31,
            email: 'l@x.com',
            updated_at: '2026-01-01T00:00:00Z',
          }),
        ),
      ).toMatchObject({ status: 'accepted' });
      expect((await customerRow(workspaceId, '31'))?.email).toBe('l@x.com');
    });

    it("Shopify's current myshopify domain captured at connect is an alias automatically", async () => {
      const [shop, current] = [newShop(), newShop()];
      const workspaceId = randomUUID();
      workspaceIds.push(workspaceId);
      await db.client
        .insert(workspaces)
        .values({ id: workspaceId, name: 'Webhook hardening spec' });
      await integrationService.connectStore(
        workspaceId,
        'shopify',
        { shopDomain: shop, accessToken: 't' },
        undefined,
        current.toUpperCase(),
      );
      const [row] = await db.client
        .select()
        .from(integrations)
        .where(eq(integrations.workspaceId, workspaceId));
      expect(row.shopDomainAliases).toEqual([current]);
      expect(
        await deliver(
          workspaceId,
          customerDelivery(current, {
            id: 41,
            email: 'c@x.com',
            updated_at: '2026-01-01T00:00:00Z',
          }),
        ),
      ).toMatchObject({ status: 'accepted' });
    });
  });

  it('D3 retention: a quarantined payload is cleared after 30 days while the row stays quarantined (still alerted)', async () => {
    const [shopA, shopB] = [newShop(), newShop()];
    const a = await store(shopA);
    await deliver(
      a.workspaceId,
      customerDelivery(shopB, { id: 81, email: 'held@x.com', updated_at: '2026-01-01T00:00:00Z' }),
    );
    const [row] = await db.client
      .select()
      .from(integrationWebhookEvents)
      .where(eq(integrationWebhookEvents.workspaceId, a.workspaceId));
    await db.client
      .update(integrationWebhookEvents)
      .set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
      .where(eq(integrationWebhookEvents.id, row.id));
    const result = await applyCompliancePayloadRetention(db.client, new Date());
    expect(result.quarantinedPayloadsCleared).toBeGreaterThanOrEqual(1);
    const [after] = await db.client
      .select()
      .from(integrationWebhookEvents)
      .where(eq(integrationWebhookEvents.id, row.id));
    expect(after).toMatchObject({ status: 'quarantined', payload: null });
  });

  describe('D1 — customer freshness and field semantics', () => {
    it('an older (out-of-order) or duplicate delivery never replaces newer data', async () => {
      const shop = newShop();
      const { workspaceId } = await store(shop);
      await deliver(
        workspaceId,
        customerDelivery(shop, {
          id: 51,
          email: 'new@x.com',
          first_name: 'New',
          updated_at: '2026-02-02T00:00:00Z',
        }),
      );
      await deliver(
        workspaceId,
        customerDelivery(shop, {
          id: 51,
          email: 'old@x.com',
          first_name: 'Old',
          updated_at: '2026-01-01T00:00:00Z',
        }),
      );
      const dup = customerDelivery(shop, {
        id: 51,
        email: 'new@x.com',
        first_name: 'New',
        updated_at: '2026-02-02T00:00:00Z',
      });
      await deliver(workspaceId, dup);
      expect(await deliver(workspaceId, dup)).toEqual({ status: 'duplicate' });
      const row = await customerRow(workspaceId, '51');
      expect(row).toMatchObject({ email: 'new@x.com', firstName: 'New' });
      expect(row.sourceUpdatedAt?.toISOString()).toBe('2026-02-02T00:00:00.000Z');
    });

    it('an omitted field is kept; an explicit null is an authoritative clear', async () => {
      const shop = newShop();
      const { workspaceId } = await store(shop);
      await deliver(
        workspaceId,
        customerDelivery(shop, {
          id: 61,
          email: 'e@x.com',
          first_name: 'F',
          last_name: 'L',
          phone: '+919876543210',
          updated_at: '2026-01-01T00:00:00Z',
        }),
      );
      // Newer delivery that withholds email/name (protected data) and explicitly clears the phone.
      await deliver(
        workspaceId,
        customerDelivery(shop, { id: 61, phone: null, updated_at: '2026-01-02T00:00:00Z' }),
      );
      expect(await customerRow(workspaceId, '61')).toMatchObject({
        email: 'e@x.com',
        firstName: 'F',
        lastName: 'L',
        phone: null,
        phoneE164: null,
      });
    });

    it('concurrent updates of one customer converge on the newest version (atomic at the database level)', async () => {
      const shop = newShop();
      const { workspaceId, integration } = await store(shop);
      const versions = [3, 1, 5, 2, 4].map((day) => ({
        externalId: '71',
        email: `v${day}@x.com`,
        firstName: `V${day}`,
        lastName: null,
        phone: null,
        sourceUpdatedAt: new Date(`2026-03-0${day}T00:00:00Z`),
        sourceCreatedAt: null,
      }));
      await Promise.all(
        versions.map((v) =>
          customers.upsertMany(workspaceId, integration.id, 'shopify', [v]).catch(() => undefined),
        ),
      );
      // Any upsert that lost an insert race retries once (as the webhook processor's retry would).
      await Promise.all(
        versions.map((v) => customers.upsertMany(workspaceId, integration.id, 'shopify', [v])),
      );
      expect(await customerRow(workspaceId, '71')).toMatchObject({
        email: 'v5@x.com',
        firstName: 'V5',
      });
    });
  });
});
