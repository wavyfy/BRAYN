import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { AppModule } from '../../../../app.module';
import { DatabaseService } from '../../../../database/database.service';
import { workspaces } from '../../../../database/schema/workspaces';
import { integrations } from '../../../../database/schema/integrations';
import { integrationWebhookEvents } from '../../../../database/schema/integration-webhook-events';
import { commerceCustomers } from '../../../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../../../database/schema/canonical-customers';
import { IntegrationService } from '../../integration.service';
import { WebhookIngestService } from '../../webhook-ingest.service';
import { WebhookEventProcessorService } from '../../webhook-event-processor.service';
import { ShopifyUninstallService } from './shopify-uninstall.service';
import type { Env } from '../../../../config/env.schema';

/**
 * App-installed Shopify store lifecycle against the real dev DB: an
 * integration whose credentials carry no per-store webhookSecret (exactly
 * what OAuth/client-credentials store) verifies business webhooks with the
 * app client secret, and app/uninstalled disconnects it while keeping its
 * data. Mocked Shopify only in the sense that the test signs deliveries
 * itself — no live store is involved.
 */
describe('Shopify app-installed store lifecycle (real DB)', { timeout: 30_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let integrationService: IntegrationService;
  let ingest: WebhookIngestService;
  let processor: WebhookEventProcessorService;
  let uninstall: ShopifyUninstallService;
  let appSecret: string;

  const workspaceId = randomUUID();
  const shopDomain = `brayn-lifecycle-${randomUUID().slice(0, 8)}.myshopify.com`;
  const customerId = String(1 + Math.floor(Math.random() * 1e12));

  function sign(body: string, secret: string) {
    return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  }

  function customerDelivery(secret: string) {
    const body = JSON.stringify({ id: Number(customerId), email: null, first_name: 'Life', last_name: 'Cycle', phone: null, updated_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' });
    return { body, headers: { 'x-shopify-topic': 'customers/create', 'x-shopify-hmac-sha256': sign(body, secret), 'x-shopify-webhook-id': randomUUID() } };
  }

  function uninstallDelivery() {
    const body = JSON.stringify({ id: 1, myshopify_domain: shopDomain });
    return {
      body,
      headers: { 'x-shopify-topic': 'app/uninstalled', 'x-shopify-shop-domain': shopDomain, 'x-shopify-hmac-sha256': sign(body, appSecret) },
    };
  }

  async function integrationRow() {
    const [row] = await db.client.select().from(integrations).where(eq(integrations.workspaceId, workspaceId));
    return row;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    const secret = moduleRef.get(ConfigService<Env, true>).get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    if (!secret) {
      throw new Error('SHOPIFY_APP_CLIENT_SECRET is not configured — this test signs deliveries with the app secret.');
    }
    appSecret = secret;
    integrationService = moduleRef.get(IntegrationService);
    ingest = moduleRef.get(WebhookIngestService);
    processor = moduleRef.get(WebhookEventProcessorService);
    uninstall = moduleRef.get(ShopifyUninstallService);

    await db.client.insert(workspaces).values({ id: workspaceId, name: 'Shopify Lifecycle Test Workspace' });
    await integrationService.connect(workspaceId, 'shopify');
    // The exact credential shape the OAuth callback stores — no webhookSecret.
    await integrationService.setCredentials(workspaceId, 'shopify', { shopDomain, accessToken: 'unused-in-this-test', grantType: 'authorization_code' });
  }, 30_000);

  afterAll(async () => {
    if (db?.isConfigured()) {
      await db.client.delete(integrationWebhookEvents).where(eq(integrationWebhookEvents.workspaceId, workspaceId));
      await db.client.delete(commerceCustomers).where(eq(commerceCustomers.workspaceId, workspaceId));
      await db.client.delete(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, workspaceId));
      await db.client.delete(integrations).where(eq(integrations.workspaceId, workspaceId));
      await db.client.delete(workspaces).where(eq(workspaces.id, workspaceId));
    }
    await moduleRef?.close();
  }, 30_000);

  it('accepts and processes a business webhook signed with the app client secret (no per-store secret stored)', async () => {
    const { body, headers } = customerDelivery(appSecret);

    const result = await ingest.ingest(workspaceId, 'shopify', body, headers);
    expect(result.status).toBe('accepted');
    await processor.processEvent((result as { webhookEventId: string }).webhookEventId);

    const rows = await db.client.select().from(commerceCustomers).where(eq(commerceCustomers.workspaceId, workspaceId));
    expect(rows.map((r) => r.externalId)).toEqual([customerId]);
  });

  it('rejects a business webhook with an invalid signature, persisting nothing', async () => {
    const { body, headers } = customerDelivery('not-the-app-secret');

    await expect(ingest.ingest(workspaceId, 'shopify', body, headers)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const rows = await db.client.select().from(integrationWebhookEvents).where(eq(integrationWebhookEvents.externalEventId, headers['x-shopify-webhook-id']));
    expect(rows).toHaveLength(0);
  });

  it('app/uninstalled disconnects the integration, clears its credentials, and keeps its historical data', async () => {
    const { body, headers } = uninstallDelivery();

    await expect(uninstall.handle(body, headers)).resolves.toEqual({ disconnected: 1 });

    const row = await integrationRow();
    expect(row.status).toBe('disconnected');
    expect(row.credentials).toBeNull();
    expect(row.shopDomain).toBe(shopDomain);
    const customers = await db.client.select().from(commerceCustomers).where(eq(commerceCustomers.workspaceId, workspaceId));
    expect(customers).toHaveLength(1);
  });

  it('refuses further ingestion for the uninstalled integration', async () => {
    const { body, headers } = customerDelivery(appSecret);

    await expect(ingest.ingest(workspaceId, 'shopify', body, headers)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('treats a repeated app/uninstalled as a harmless no-op', async () => {
    const { body, headers } = uninstallDelivery();

    await expect(uninstall.handle(body, headers)).resolves.toEqual({ disconnected: 0 });
    expect((await integrationRow()).status).toBe('disconnected');
  });
});
