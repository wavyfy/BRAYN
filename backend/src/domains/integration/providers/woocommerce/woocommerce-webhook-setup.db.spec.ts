import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray, sql } from 'drizzle-orm';
import { AppModule } from '../../../../app.module';
import { DatabaseService } from '../../../../database/database.service';
import { workspaces } from '../../../../database/schema/workspaces';
import { integrations } from '../../../../database/schema/integrations';
import { integrationWebhookEvents } from '../../../../database/schema/integration-webhook-events';
import { commerceCustomers } from '../../../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../../../database/schema/canonical-customers';
import { ConflictError, UnauthenticatedError } from '../../../../common/errors/app-error';
import { IntegrationService } from '../../integration.service';
import { WebhookIngestService } from '../../webhook-ingest.service';
import { WebhookEventProcessorService } from '../../webhook-event-processor.service';
import { WooCommerceWebhookSetupService, WOOCOMMERCE_SETUP_TOPICS } from './woocommerce-webhook-setup.service';

/**
 * Manual WooCommerce webhook setup against the real dev DB, with simulated (signed) WooCommerce deliveries — no real
 * store. Proves the generated secret is stored encrypted next to the API keys, is never returned by settings, verifies
 * a delivery end to end through the existing ingestion/processing pipeline, and that rotation invalidates the old one.
 */
describe('WooCommerce manual webhook setup (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let setup: WooCommerceWebhookSetupService;
  let integrationService: IntegrationService;
  let ingest: WebhookIngestService;
  let processor: WebhookEventProcessorService;
  const wsA = randomUUID();
  const wsB = randomUUID();
  const apiKeys = { storeUrl: 'https://brayn-woo-test.example.com', consumerKey: 'ck_test', consumerSecret: 'cs_test' };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    setup = moduleRef.get(WooCommerceWebhookSetupService);
    integrationService = moduleRef.get(IntegrationService);
    ingest = moduleRef.get(WebhookIngestService);
    processor = moduleRef.get(WebhookEventProcessorService);
    await db.client.insert(workspaces).values([
      { id: wsA, name: 'WooCommerce Webhook Setup Test A' },
      { id: wsB, name: 'WooCommerce Webhook Setup Test B' },
    ]);
    for (const ws of [wsA, wsB]) {
      await integrationService.connect(ws, 'woocommerce');
      // Stored directly: verifyConnection would need a real store (none in this environment).
      await integrationService.setCredentials(ws, 'woocommerce', apiKeys);
    }
  }, 60_000);

  afterAll(async () => {
    if (db?.isConfigured()) {
      const ids = [wsA, wsB];
      await db.client.delete(integrationWebhookEvents).where(inArray(integrationWebhookEvents.workspaceId, ids));
      await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
      await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
      await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
      await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    }
    await moduleRef?.close();
  }, 60_000);

  /** A WooCommerce `customer.created` delivery signed with `secret` (X-WC-Webhook-Signature = base64 HMAC-SHA256 of the raw body). */
  function delivery(secret: string, customerId = 1 + Math.floor(Math.random() * 1e9)) {
    const body = JSON.stringify({
      id: customerId,
      email: null,
      first_name: 'Woo',
      last_name: 'Setup',
      date_created_gmt: '2026-01-01T00:00:00',
      date_modified_gmt: '2026-01-01T00:00:00',
      billing: { phone: null },
    });
    const headers = {
      'x-wc-webhook-topic': 'customer.created',
      'x-wc-webhook-signature': createHmac('sha256', secret).update(body, 'utf8').digest('base64'),
      'x-wc-webhook-delivery-id': randomUUID(),
    };
    return { body, headers, externalId: String(customerId) };
  }

  const customerRows = (workspaceId: string, externalId: string) =>
    db.client
      .select({ id: commerceCustomers.id })
      .from(commerceCustomers)
      .where(sql`${commerceCustomers.workspaceId} = ${workspaceId} and ${commerceCustomers.provider} = 'woocommerce' and ${commerceCustomers.externalId} = ${externalId}`);

  async function waitProcessed(workspaceId: string, webhookEventId: string) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      await processor.processDue(undefined, { workspaceId });
      const [row] = await db.client.select().from(integrationWebhookEvents).where(eq(integrationWebhookEvents.id, webhookEventId));
      if (row?.status === 'processed') return row;
      if (Date.now() > deadline) throw new Error(`webhook event stayed ${row?.status}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('settings report the delivery URL and topics, never a secret, and nothing configured before setup', async () => {
    const settings = await setup.getSettings(wsA);

    expect(settings).toEqual({
      webhookUrl: expect.stringMatching(new RegExp(`/api/v1/workspaces/${wsA}/integrations/woocommerce/webhooks$`)),
      topics: WOOCOMMERCE_SETUP_TOPICS,
      secretConfigured: false,
    });
    expect(settings).not.toHaveProperty('webhookSecret');
  });

  it('generates a secret stored encrypted alongside the unchanged API keys; a signed delivery is processed end to end', async () => {
    const { webhookSecret, secretConfigured } = await setup.generateSecret(wsA);

    expect(secretConfigured).toBe(true);
    expect(webhookSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await integrationService.getCredentials(wsA, 'woocommerce')).toEqual({ ...apiKeys, webhookSecret });
    const [stored] = await db.client.select({ credentials: integrations.credentials }).from(integrations).where(eq(integrations.workspaceId, wsA));
    expect(JSON.stringify(stored.credentials)).not.toContain(webhookSecret);
    expect(await setup.getSettings(wsA)).toMatchObject({ secretConfigured: true });
    expect(await setup.getSettings(wsA)).not.toHaveProperty('webhookSecret');

    const d = delivery(webhookSecret);
    const result = await ingest.ingest(wsA, 'woocommerce', d.body, d.headers);
    expect(result.status).toBe('accepted');
    await waitProcessed(wsA, (result as { webhookEventId: string }).webhookEventId);
    expect(await customerRows(wsA, d.externalId)).toHaveLength(1);

    // Redelivery of the same WooCommerce delivery id is deduplicated by the existing pipeline.
    expect(await ingest.ingest(wsA, 'woocommerce', d.body, d.headers)).toEqual({ status: 'duplicate' });
  });

  it('regenerating rotates: the old secret stops verifying and the new one works', async () => {
    const { webhookSecret: oldSecret } = await setup.generateSecret(wsA);
    const { webhookSecret: newSecret } = await setup.generateSecret(wsA);
    expect(newSecret).not.toBe(oldSecret);

    const stale = delivery(oldSecret);
    await expect(ingest.ingest(wsA, 'woocommerce', stale.body, stale.headers)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(await customerRows(wsA, stale.externalId)).toHaveLength(0);

    const fresh = delivery(newSecret);
    expect((await ingest.ingest(wsA, 'woocommerce', fresh.body, fresh.headers)).status).toBe('accepted');
  });

  it('isolation: each workspace has its own secret; one workspace secret never verifies for another', async () => {
    const { webhookSecret: secretA } = await setup.generateSecret(wsA);
    const { webhookSecret: secretB } = await setup.generateSecret(wsB);
    expect(secretA).not.toBe(secretB);

    const crossTenant = delivery(secretA);
    await expect(ingest.ingest(wsB, 'woocommerce', crossTenant.body, crossTenant.headers)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(await customerRows(wsB, crossTenant.externalId)).toHaveLength(0);
    expect((await integrationService.getCredentials(wsB, 'woocommerce'))?.consumerKey).toBe(apiKeys.consumerKey);
  });

  it('refuses to generate a secret without connected API keys (never stores a secret on its own)', async () => {
    const wsC = randomUUID();
    await db.client.insert(workspaces).values({ id: wsC, name: 'WooCommerce Webhook Setup Test C' });
    try {
      await expect(setup.generateSecret(wsC)).rejects.toBeInstanceOf(ConflictError);
      await integrationService.connect(wsC, 'woocommerce');
      await expect(setup.generateSecret(wsC)).rejects.toBeInstanceOf(ConflictError);
      expect(await integrationService.getCredentials(wsC, 'woocommerce')).toBeNull();
    } finally {
      await db.client.delete(integrations).where(eq(integrations.workspaceId, wsC));
      await db.client.delete(workspaces).where(eq(workspaces.id, wsC));
    }
  });

  it('disconnecting clears the secret with the credentials', async () => {
    await setup.generateSecret(wsB);
    await integrationService.disconnect(wsB, 'woocommerce');

    expect(await setup.getSettings(wsB)).toMatchObject({ secretConfigured: false });
    await expect(setup.generateSecret(wsB)).rejects.toBeInstanceOf(ConflictError);
  });
});
