import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray } from 'drizzle-orm';
import { AppModule } from '../../../../app.module';
import { DatabaseService } from '../../../../database/database.service';
import { workspaces } from '../../../../database/schema/workspaces';
import { integrations } from '../../../../database/schema/integrations';
import { integrationImportRuns } from '../../../../database/schema/integration-import-runs';
import { commerceCustomers } from '../../../../database/schema/commerce-customers';
import { customerDataRequests } from '../../../../database/schema/customer-data-requests';
import { ConflictError, UnauthenticatedError } from '../../../../common/errors/app-error';
import { IntegrationService, STORE_OWNED_ELSEWHERE_MESSAGE } from '../../integration.service';
import { ShopifyComplianceService } from './shopify-compliance.service';
import { ShopifyUninstallService } from './shopify-uninstall.service';
import { ShopifyAdapter } from './shopify.adapter';
import type { Env } from '../../../../config/env.schema';

/**
 * Store ownership against the real dev DB (migration 0053, `integrations_shopify_live_shop_unique`): one Shopify store
 * is live in at most one workspace, enforced by the database so concurrent OAuth callbacks can't both win, and
 * compliance webhooks reach every workspace that holds the store's data instead of the most recently updated row.
 */
describe('Shopify store ownership (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let service: IntegrationService;
  let compliance: ShopifyComplianceService;
  let uninstall: ShopifyUninstallService;
  let appSecret: string;
  const workspaceIds: string[] = [];

  const newShop = () => `ownership-${randomUUID().slice(0, 8)}.myshopify.com`;
  const creds = (shopDomain: string, accessToken = 'shpat_test') => ({
    shopDomain,
    accessToken,
    grantType: 'authorization_code',
  });
  const sign = (body: string) =>
    createHmac('sha256', appSecret).update(body, 'utf8').digest('base64');

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error(
        'DATABASE_URL is not configured — this integration test requires the real dev database.',
      );
    }
    const secret = moduleRef
      .get(ConfigService<Env, true>)
      .get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    if (!secret) {
      throw new Error(
        'SHOPIFY_APP_CLIENT_SECRET is not configured — this test signs compliance deliveries with the app secret.',
      );
    }
    appSecret = secret;
    service = moduleRef.get(IntegrationService);
    compliance = moduleRef.get(ShopifyComplianceService);
    uninstall = moduleRef.get(ShopifyUninstallService);
  }, 60_000);

  afterAll(async () => {
    if (db?.isConfigured() && workspaceIds.length > 0) {
      await db.client
        .delete(customerDataRequests)
        .where(inArray(customerDataRequests.workspaceId, workspaceIds));
      await db.client
        .delete(integrationImportRuns)
        .where(inArray(integrationImportRuns.workspaceId, workspaceIds));
      await db.client
        .delete(commerceCustomers)
        .where(inArray(commerceCustomers.workspaceId, workspaceIds));
      await db.client.delete(integrations).where(inArray(integrations.workspaceId, workspaceIds));
      await db.client.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
    }
    await moduleRef?.close();
  }, 60_000);

  async function workspace() {
    const id = randomUUID();
    workspaceIds.push(id);
    await db.client.insert(workspaces).values({ id, name: 'Store ownership spec' });
    return id;
  }

  /** The OAuth sequence both Shopify connect flows run. */
  async function oauth(workspaceId: string, shopDomain: string, accessToken?: string) {
    const prepared = await service.prepareStoreConnection(workspaceId, 'shopify', shopDomain);
    if (prepared !== 'ok') return prepared;
    return service.connectStore(workspaceId, 'shopify', creds(shopDomain, accessToken));
  }

  async function row(workspaceId: string) {
    const [r] = await db.client
      .select()
      .from(integrations)
      .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'shopify')));
    return r;
  }

  async function addCustomer(workspaceId: string, externalId: string) {
    const r = await row(workspaceId);
    await db.client
      .insert(commerceCustomers)
      .values({ workspaceId, integrationId: r.id, provider: 'shopify', externalId });
  }

  const customerCount = async (workspaceId: string) =>
    (
      await db.client
        .select({ id: commerceCustomers.id })
        .from(commerceCustomers)
        .where(eq(commerceCustomers.workspaceId, workspaceId))
    ).length;

  it('same-store re-authorization in the owning workspace refreshes credentials and keeps one live row', async () => {
    const a = await workspace();
    const shop = newShop();
    expect(await oauth(a, shop, 't1')).toBe('ok');
    const first = await row(a);
    expect(await oauth(a, shop, 't2')).toBe('ok');
    const second = await row(a);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('connected');
    expect(second.credentials).not.toBe(first.credentials);
    expect((await service.getCredentials(a, 'shopify'))?.accessToken).toBe('t2');
  });

  it('a second workspace is refused for a store that is live elsewhere, with nothing written for it', async () => {
    const [a, b] = [await workspace(), await workspace()];
    const shop = newShop();
    expect(await oauth(a, shop)).toBe('ok');

    expect(await service.prepareStoreConnection(b, 'shopify', shop)).toBe('owned_elsewhere');
    // Bypassing the pre-check (the race case) hits the DB invariant: still refused, still nothing written.
    expect(await service.connectStore(b, 'shopify', creds(shop))).toBe('owned_elsewhere');
    expect(await row(b)).toBeUndefined();
    expect((await row(a)).status).toBe('connected');
  });

  it('concurrent OAuth for one store across workspaces: exactly one wins (DB-enforced, not a pre-insert read)', async () => {
    const ids = await Promise.all([
      workspace(),
      workspace(),
      workspace(),
      workspace(),
      workspace(),
    ]);
    const shop = newShop();
    const results = await Promise.all(
      ids.map((id) => service.connectStore(id, 'shopify', creds(shop))),
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'owned_elsewhere')).toHaveLength(4);
    const live = await db.client
      .select({ id: integrations.id })
      .from(integrations)
      .where(and(inArray(integrations.workspaceId, ids), eq(integrations.status, 'connected')));
    expect(live).toHaveLength(1);
  });

  it('domain aliases by case resolve to one store: stored lowercase, and a differently-cased connect is refused', async () => {
    const [a, b] = [await workspace(), await workspace()];
    const shop = newShop();
    expect(await oauth(a, shop.toUpperCase())).toBe('ok');
    expect((await row(a)).shopDomain).toBe(shop);
    expect(await oauth(b, `${shop.slice(0, 3).toUpperCase()}${shop.slice(3)}`)).toBe(
      'owned_elsewhere',
    );
    expect(await service.connectStore(b, 'shopify', creds(shop.toUpperCase()))).toBe(
      'owned_elsewhere',
    );
  });

  it('the manual credentials path and a generic reconnect hit the same invariant with a generic message', async () => {
    const [a, b] = [await workspace(), await workspace()];
    const shop = newShop();
    expect(await oauth(a, shop)).toBe('ok');
    await service.connect(b, 'shopify');
    const err = await service.setCredentials(b, 'shopify', creds(shop)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toBe(STORE_OWNED_ELSEWHERE_MESSAGE);
    expect((err as Error).message).not.toContain(a);
    // Manual path: unverified credentials learn nothing about ownership; verified ones get the generic conflict.
    const verify = vi
      .spyOn(moduleRef.get(ShopifyAdapter), 'verifyConnection')
      .mockResolvedValueOnce(false);
    await expect(service.connectCredentials(b, 'shopify', creds(shop))).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
    verify.mockResolvedValueOnce(true);
    await expect(service.connectCredentials(b, 'shopify', creds(shop))).rejects.toThrow(
      STORE_OWNED_ELSEWHERE_MESSAGE,
    );
    verify.mockRestore();
    expect((await row(b)).shopDomain).toBeNull();
  });

  it('a disconnected (revoked) owner with no data left frees the store; its own reconnect is then refused, not a silent takeover', async () => {
    const [a, b] = [await workspace(), await workspace()];
    const shop = newShop();
    expect(await oauth(a, shop)).toBe('ok');
    await service.disconnect(a, 'shopify');
    expect((await row(a)).credentials).toBeNull();

    expect(await oauth(b, shop)).toBe('ok');
    expect(await service.prepareStoreConnection(a, 'shopify', shop)).toBe('owned_elsewhere');
    await expect(service.connect(a, 'shopify')).rejects.toThrow(STORE_OWNED_ELSEWHERE_MESSAGE);
    expect((await row(a)).status).toBe('disconnected');
    expect((await row(b)).status).toBe('connected');
  });

  it('a disconnected owner that still holds the store data keeps it: another workspace is refused until an explicit transfer', async () => {
    const [a, b] = [await workspace(), await workspace()];
    const shop = newShop();
    expect(await oauth(a, shop)).toBe('ok');
    await addCustomer(a, 'c-1');
    await service.disconnect(a, 'shopify');

    expect(await oauth(b, shop)).toBe('owned_elsewhere');
    expect(await row(b)).toBeUndefined();
    expect(await customerCount(a)).toBe(1);
  });

  it('uninstall then reinstall in the same workspace reconnects the same row and keeps its data', async () => {
    const a = await workspace();
    const shop = newShop();
    expect(await oauth(a, shop)).toBe('ok');
    await addCustomer(a, 'c-1');
    const body = JSON.stringify({ id: 1, myshopify_domain: shop });
    await uninstall.handle(body, {
      'x-shopify-topic': 'app/uninstalled',
      'x-shopify-shop-domain': shop,
      'x-shopify-hmac-sha256': sign(body),
    });
    const uninstalled = await row(a);
    expect(uninstalled.status).toBe('disconnected');

    expect(await oauth(a, shop, 'reinstalled')).toBe('ok');
    const reinstalled = await row(a);
    expect(reinstalled.id).toBe(uninstalled.id);
    expect(reinstalled.status).toBe('connected');
    expect(await customerCount(a)).toBe(1);
  });

  describe('compliance routing when more than one workspace holds the store', () => {
    /** A (old owner, disconnected, data retained) and B (current live owner) both hold `shop`; C is an unrelated store. */
    async function ambiguous() {
      const [a, b, c] = [await workspace(), await workspace(), await workspace()];
      const shop = newShop();
      expect(await oauth(a, shop)).toBe('ok');
      await addCustomer(a, 'c-1');
      await service.disconnect(a, 'shopify');
      // A historical state the pre-check now prevents (A still holds data); written directly, as pre-0053 code could.
      await service.connect(b, 'shopify');
      await service.setCredentials(b, 'shopify', creds(shop));
      await addCustomer(b, 'c-1');
      await addCustomer(b, 'c-2');
      expect(await oauth(c, newShop())).toBe('ok');
      await addCustomer(c, 'c-1');
      // B is the most recently updated: the old resolver would have touched only B and left A's copy behind.
      await db.client
        .update(integrations)
        .set({ lastSyncError: null })
        .where(eq(integrations.id, (await row(b)).id));
      return { a, b, c, shop };
    }
    const deliver = (topic: string, payload: object) => {
      const body = JSON.stringify(payload);
      return compliance.handle(topic, body, { 'x-shopify-hmac-sha256': sign(body) });
    };

    it('customers/redact erases the customer in every workspace holding the store, and nowhere else', async () => {
      const { a, b, c, shop } = await ambiguous();
      await deliver('customers/redact', {
        shop_domain: shop.toUpperCase(),
        customer: { id: 'c-1' },
      });
      expect(await customerCount(a)).toBe(0);
      expect(await customerCount(b)).toBe(1); // c-2 is another customer
      expect(await customerCount(c)).toBe(1); // same external id, different store
    });

    it('shop/redact erases every row holding the store (live and disconnected) and leaves other stores alone', async () => {
      const { a, b, c, shop } = await ambiguous();
      await deliver('shop/redact', { shop_domain: shop });
      for (const id of [a, b]) {
        const r = await row(id);
        expect(r.status).toBe('disconnected');
        expect(r.shopDomain).toBeNull();
        expect(r.credentials).toBeNull();
        expect(await customerCount(id)).toBe(0);
      }
      expect((await row(c)).status).toBe('connected');
      expect(await customerCount(c)).toBe(1);
      // A repeat delivery is a safe no-op; the store is now free for a fresh connection.
      await deliver('shop/redact', { shop_domain: shop });
      expect(await oauth(c, shop)).toBe('different_store');
      expect(await oauth(await workspace(), shop)).toBe('ok');
    });

    it('customers/data_request is recorded for each workspace holding the store, never for an unrelated one', async () => {
      const { a, b, c, shop } = await ambiguous();
      await deliver('customers/data_request', {
        shop_domain: shop,
        customer: { id: 'c-1' },
        orders_requested: [],
      });
      const records = await db.client
        .select({ workspaceId: customerDataRequests.workspaceId })
        .from(customerDataRequests)
        .where(inArray(customerDataRequests.workspaceId, [a, b, c]));
      expect(records.map((r) => r.workspaceId).sort()).toEqual([a, b].sort());
    });
  });
});
