import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { inArray } from 'drizzle-orm';
import { AppModule } from '../../../../app.module';
import { DatabaseService } from '../../../../database/database.service';
import { workspaces } from '../../../../database/schema/workspaces';
import { integrations } from '../../../../database/schema/integrations';
import { integrationWebhookEvents } from '../../../../database/schema/integration-webhook-events';
import { commerceCustomers } from '../../../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../../../database/schema/canonical-customers';
import { ProviderError, UnauthenticatedError } from '../../../../common/errors/app-error';
import { IntegrationService } from '../../integration.service';
import { WebhookIngestService } from '../../webhook-ingest.service';
import { ShopifyAdapter } from '../shopify/shopify.adapter';
import { WooCommerceAdapter } from './woocommerce.adapter';
import { WooCommerceWebhookSetupService } from './woocommerce-webhook-setup.service';

/**
 * Stage 10 Slice 3 product rules through the real `IntegrationService.connectCredentials` and encrypted storage:
 * same store keeps the webhook secret, a different store clears it, a failed reconnect changes nothing, disconnect
 * clears everything. `verifyConnection` is stubbed — no real WooCommerce store in this environment.
 */
describe('WooCommerce reconnect keeps or clears the webhook secret (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let integrationService: IntegrationService;
  let setup: WooCommerceWebhookSetupService;
  let ingest: WebhookIngestService;
  let woo: WooCommerceAdapter;
  const wsA = randomUUID();
  const wsB = randomUUID();
  const keys = (storeUrl: string, suffix: string) => ({ storeUrl, consumerKey: `ck_${suffix}`, consumerSecret: `cs_${suffix}` });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    integrationService = moduleRef.get(IntegrationService);
    setup = moduleRef.get(WooCommerceWebhookSetupService);
    ingest = moduleRef.get(WebhookIngestService);
    woo = moduleRef.get(WooCommerceAdapter);
    await db.client.insert(workspaces).values([
      { id: wsA, name: 'WooCommerce Reconnect Test A' },
      { id: wsB, name: 'WooCommerce Reconnect Test B' },
    ]);
  }, 60_000);

  afterEach(() => vi.restoreAllMocks());

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

  /** A fresh WooCommerce connection in `ws` with keys for `storeUrl` and a generated webhook secret. */
  async function connectedWithSecret(ws: string, storeUrl: string) {
    await integrationService.disconnect(ws, 'woocommerce').catch(() => undefined);
    await integrationService.connect(ws, 'woocommerce');
    vi.spyOn(woo, 'verifyConnection').mockResolvedValue(true);
    await integrationService.connectCredentials(ws, 'woocommerce', keys(storeUrl, 'first'));
    return (await setup.generateSecret(ws)).webhookSecret;
  }

  function signedCustomerDelivery(secret: string) {
    const body = JSON.stringify({ id: 1 + Math.floor(Math.random() * 1e9), email: null, first_name: 'Re', last_name: 'Connect', billing: { phone: null } });
    return {
      body,
      headers: {
        'x-wc-webhook-topic': 'customer.updated',
        'x-wc-webhook-signature': createHmac('sha256', secret).update(body, 'utf8').digest('base64'),
        'x-wc-webhook-delivery-id': randomUUID(),
      },
    };
  }

  it('same store, new keys: keys are replaced and the existing secret keeps verifying deliveries', async () => {
    const secret = await connectedWithSecret(wsA, 'https://shop.example.com');

    // Same store written differently: host case, default port, trailing slash.
    await integrationService.connectCredentials(wsA, 'woocommerce', keys('https://SHOP.example.com:443/', 'second'));

    expect(await integrationService.getCredentials(wsA, 'woocommerce')).toEqual({ ...keys('https://SHOP.example.com:443/', 'second'), webhookSecret: secret });
    expect(await setup.getSettings(wsA)).toMatchObject({ secretConfigured: true });
    const d = signedCustomerDelivery(secret);
    expect((await ingest.ingest(wsA, 'woocommerce', d.body, d.headers)).status).toBe('accepted');
  });

  it('different store: the old secret is cleared and fresh webhook setup is required', async () => {
    const secret = await connectedWithSecret(wsA, 'https://shop.example.com');

    await integrationService.connectCredentials(wsA, 'woocommerce', keys('https://other-shop.example.com', 'other'));

    expect(await integrationService.getCredentials(wsA, 'woocommerce')).toEqual(keys('https://other-shop.example.com', 'other'));
    expect(await setup.getSettings(wsA)).toMatchObject({ secretConfigured: false });
    const d = signedCustomerDelivery(secret);
    await expect(ingest.ingest(wsA, 'woocommerce', d.body, d.headers)).rejects.toThrow('No webhook secret is configured');
  });

  it('failed reconnect (rejected keys or unreachable store): previous keys and secret are untouched', async () => {
    const secret = await connectedWithSecret(wsA, 'https://shop.example.com');
    const before = await integrationService.getCredentials(wsA, 'woocommerce');

    vi.spyOn(woo, 'verifyConnection').mockResolvedValueOnce(false);
    await expect(integrationService.connectCredentials(wsA, 'woocommerce', keys('https://shop.example.com', 'bad'))).rejects.toBeInstanceOf(UnauthenticatedError);
    vi.spyOn(woo, 'verifyConnection').mockRejectedValueOnce(new ProviderError('Could not reach WooCommerce store.'));
    await expect(integrationService.connectCredentials(wsA, 'woocommerce', keys('https://other-shop.example.com', 'bad'))).rejects.toBeInstanceOf(ProviderError);

    expect(await integrationService.getCredentials(wsA, 'woocommerce')).toEqual(before);
    expect(before?.webhookSecret).toBe(secret);
  });

  it('rotation still works after a same-store reconnect, and the rotated secret survives the next one', async () => {
    const original = await connectedWithSecret(wsA, 'https://shop.example.com');
    await integrationService.connectCredentials(wsA, 'woocommerce', keys('https://shop.example.com', 'second'));

    const { webhookSecret: rotated } = await setup.generateSecret(wsA);
    await integrationService.connectCredentials(wsA, 'woocommerce', keys('https://shop.example.com/', 'third'));

    expect(rotated).not.toBe(original);
    expect((await integrationService.getCredentials(wsA, 'woocommerce'))?.webhookSecret).toBe(rotated);
    const stale = signedCustomerDelivery(original);
    await expect(ingest.ingest(wsA, 'woocommerce', stale.body, stale.headers)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('explicit disconnect clears keys and secret; reconnecting the same store does not resurrect the old secret', async () => {
    await connectedWithSecret(wsA, 'https://shop.example.com');

    await integrationService.disconnect(wsA, 'woocommerce');
    expect(await integrationService.getCredentials(wsA, 'woocommerce')).toBeNull();

    await integrationService.connect(wsA, 'woocommerce');
    await integrationService.connectCredentials(wsA, 'woocommerce', keys('https://shop.example.com', 'again'));
    expect(await integrationService.getCredentials(wsA, 'woocommerce')).toEqual(keys('https://shop.example.com', 'again'));
  });

  it('isolation: one workspace reconnecting never affects another workspace secret', async () => {
    const secretA = await connectedWithSecret(wsA, 'https://shop.example.com');
    const secretB = await connectedWithSecret(wsB, 'https://shop.example.com');

    await integrationService.connectCredentials(wsA, 'woocommerce', keys('https://other-shop.example.com', 'moved'));

    expect((await integrationService.getCredentials(wsA, 'woocommerce'))?.webhookSecret).toBeUndefined();
    expect((await integrationService.getCredentials(wsB, 'woocommerce'))?.webhookSecret).toBe(secretB);
    expect(secretA).not.toBe(secretB);
  });

  it('Shopify keeps its existing behaviour: re-entered credentials replace the stored ones as-is', async () => {
    await integrationService.connect(wsB, 'shopify');
    vi.spyOn(moduleRef.get(ShopifyAdapter), 'verifyConnection').mockResolvedValue(true);
    await integrationService.connectCredentials(wsB, 'shopify', { shopDomain: 'x.myshopify.com', accessToken: 't1', webhookSecret: 's1' });

    await integrationService.connectCredentials(wsB, 'shopify', { shopDomain: 'x.myshopify.com', accessToken: 't2' });

    expect(await integrationService.getCredentials(wsB, 'shopify')).toEqual({ shopDomain: 'x.myshopify.com', accessToken: 't2' });
  });
});
