import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { AppModule } from '../../../../app.module';
import { DatabaseService } from '../../../../database/database.service';
import { workspaces } from '../../../../database/schema/workspaces';
import { integrations } from '../../../../database/schema/integrations';
import { integrationImportRuns } from '../../../../database/schema/integration-import-runs';
import { commerceCustomers } from '../../../../database/schema/commerce-customers';
import { customerDataRequests } from '../../../../database/schema/customer-data-requests';
import { commerceOrders } from '../../../../database/schema/commerce-orders';
import { shopifyComplianceWebhooks } from '../../../../database/schema/shopify-compliance-webhooks';
import {
  ConflictError,
  NotFoundError,
  UnauthenticatedError,
} from '../../../../common/errors/app-error';
import { IntegrationService, STORE_OWNED_ELSEWHERE_MESSAGE } from '../../integration.service';
import { ShopifyComplianceService } from './shopify-compliance.service';
import { ShopifyUninstallService } from './shopify-uninstall.service';
import { ShopifyAdapter } from './shopify.adapter';
import { applyCompliancePayloadRetention } from './shopify-compliance-retention';
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

  const shops: string[] = [];
  const newShop = () => {
    const shop = `ownership-${randomUUID().slice(0, 8)}.myshopify.com`;
    shops.push(shop, shop.toUpperCase());
    return shop;
  };
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
        .delete(commerceOrders)
        .where(inArray(commerceOrders.workspaceId, workspaceIds));
      await db.client
        .delete(commerceCustomers)
        .where(inArray(commerceCustomers.workspaceId, workspaceIds));
      await db.client
        .delete(shopifyComplianceWebhooks)
        .where(inArray(shopifyComplianceWebhooks.shopDomain, shops));
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

  describe('historical holders and races', () => {
    it('a former holder cannot re-claim the store through a generic reconnect (no credential-less squatting)', async () => {
      const [a, b] = [await workspace(), await workspace()];
      const shop = newShop();
      expect(await oauth(a, shop)).toBe('ok');
      await service.disconnect(a, 'shopify');
      expect(await oauth(b, shop)).toBe('ok');
      await expect(service.connect(a, 'shopify')).rejects.toThrow(STORE_OWNED_ELSEWHERE_MESSAGE);
      // Same when the other holder is disconnected but still has the store data.
      await addCustomer(b, 'c-1');
      await service.disconnect(b, 'shopify');
      await expect(service.connect(a, 'shopify')).rejects.toThrow(STORE_OWNED_ELSEWHERE_MESSAGE);
      expect((await row(a)).status).toBe('disconnected');
    });

    it('new workspaces racing for a store whose disconnected holder keeps its data are all refused', async () => {
      const a = await workspace();
      const shop = newShop();
      expect(await oauth(a, shop)).toBe('ok');
      await addCustomer(a, 'c-1');
      await service.disconnect(a, 'shopify');
      const racers = await Promise.all([workspace(), workspace(), workspace()]);
      const results = await Promise.all(racers.map((id) => oauth(id, shop)));
      expect(results).toEqual(['owned_elsewhere', 'owned_elsewhere', 'owned_elsewhere']);
      for (const id of racers) expect(await row(id)).toBeUndefined();
    });

    it('the holder reconnecting while a new workspace connects: exactly one ends up live', async () => {
      const [a, b] = [await workspace(), await workspace()];
      const shop = newShop();
      expect(await oauth(a, shop)).toBe('ok');
      await service.disconnect(a, 'shopify');
      const results = await Promise.all([
        service.connectStore(a, 'shopify', creds(shop)),
        service.connectStore(b, 'shopify', creds(shop)),
      ]);
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      const live = await db.client
        .select({ id: integrations.id })
        .from(integrations)
        .where(
          and(inArray(integrations.workspaceId, [a, b]), eq(integrations.status, 'connected')),
        );
      expect(live).toHaveLength(1);
    });
  });

  describe('compliance retry contract and audit (shopify_compliance_webhooks)', () => {
    const deliverWithId = (webhookId: string, topic: string, payload: object) => {
      const body = JSON.stringify(payload);
      return compliance.handle(topic, body, {
        'x-shopify-hmac-sha256': sign(body),
        'x-shopify-webhook-id': webhookId,
      });
    };
    const auditRow = async (webhookId: string) => {
      const [r] = await db.client
        .select()
        .from(shopifyComplianceWebhooks)
        .where(eq(shopifyComplianceWebhooks.webhookId, webhookId));
      return r;
    };
    const dataRequestCount = async (workspaceId: string) =>
      (
        await db.client
          .select({ id: customerDataRequests.id })
          .from(customerDataRequests)
          .where(eq(customerDataRequests.workspaceId, workspaceId))
      ).length;

    it('redelivered and concurrent copies of one data_request record it exactly once, audited without customer identifiers', async () => {
      const a = await workspace();
      const shop = newShop();
      expect(await oauth(a, shop)).toBe('ok');
      const id = `wh-${randomUUID()}`;
      const payload = {
        shop_id: 954889,
        shop_domain: shop,
        customer: { id: 191167, email: 'jane@example.com' },
      };
      const outcomes = await Promise.allSettled([
        deliverWithId(id, 'customers/data_request', payload),
        deliverWithId(id, 'customers/data_request', payload),
      ]);
      // Each copy is either acknowledged or told to retry (409); never processed twice.
      for (const o of outcomes) {
        if (o.status === 'rejected') expect(o.reason).toBeInstanceOf(ConflictError);
      }
      await deliverWithId(id, 'customers/data_request', payload);
      expect(await dataRequestCount(a)).toBe(1);
      const audit = await auditRow(id);
      expect(audit).toMatchObject({
        status: 'processed',
        outcome: 'recorded',
        matchedIntegrations: 1,
        shopId: '954889',
        topic: 'customers/data_request',
      });
      expect(JSON.stringify(audit)).not.toContain('jane@example.com');
      expect(JSON.stringify(audit)).not.toContain('191167');
    });

    it('a failed erasure is recorded as failed and fully redone by the redelivery', async () => {
      const [a, b] = [await workspace(), await workspace()];
      const shop = newShop();
      expect(await oauth(a, shop)).toBe('ok');
      await addCustomer(a, 'c-1');
      await service.disconnect(a, 'shopify');
      // b: a second holder (historical duplicate); the first holder's erasure fails once.
      await service.connect(b, 'shopify');
      await service.setCredentials(b, 'shopify', creds(shop));
      await addCustomer(b, 'c-1');
      const id = `wh-${randomUUID()}`;
      const erase = vi
        .spyOn(service, 'eraseIntegrationForShopRedact')
        .mockRejectedValueOnce(Object.assign(new Error('simulated'), { code: '40P01' }));

      await expect(deliverWithId(id, 'shop/redact', { shop_domain: shop })).rejects.toThrow(
        'simulated',
      );
      expect(await auditRow(id)).toMatchObject({ status: 'failed', error: '40P01' });
      expect(await customerCount(b)).toBe(1); // nothing claimed as done

      await deliverWithId(id, 'shop/redact', { shop_domain: shop });
      erase.mockRestore();
      expect(await auditRow(id)).toMatchObject({
        status: 'processed',
        outcome: 'erased',
        matchedIntegrations: 2,
        attempts: 2,
      });
      expect(await customerCount(a)).toBe(0);
      expect(await customerCount(b)).toBe(0);
    });

    it('customers/redact erases the listed orders even when the customer row is unknown', async () => {
      const a = await workspace();
      const shop = newShop();
      expect(await oauth(a, shop)).toBe('ok');
      const integrationId = (await row(a)).id;
      await db.client.insert(commerceOrders).values([
        { workspaceId: a, integrationId, provider: 'shopify', externalId: '299938' },
        { workspaceId: a, integrationId, provider: 'shopify', externalId: '777' },
      ]);
      const id = `wh-${randomUUID()}`;
      await deliverWithId(id, 'customers/redact', {
        shop_domain: shop,
        customer: { id: 424242 },
        orders_to_redact: [299938],
      });
      const left = await db.client
        .select({ externalId: commerceOrders.externalId })
        .from(commerceOrders)
        .where(eq(commerceOrders.workspaceId, a));
      expect(left.map((o) => o.externalId)).toEqual(['777']);
      expect(await auditRow(id)).toMatchObject({ status: 'processed', outcome: 'erased' });
    });

    it('an unknown shop is acknowledged but stays an open privacy exception (never processed) until an operator resolves it', async () => {
      const id = `wh-${randomUUID()}`;
      const shop = newShop();
      await expect(
        deliverWithId(id, 'shop/redact', { shop_id: 1, shop_domain: shop }),
      ).resolves.toBeUndefined();
      const open = await auditRow(id);
      expect(open).toMatchObject({
        status: 'exception',
        exceptionReason: 'unknown_shop',
        outcome: 'unknown_shop',
        matchedIntegrations: 0,
      });
      expect(open.payload).not.toBeNull(); // kept for replay
      expect((await compliance.openIssues()).count).toBeGreaterThanOrEqual(1);
      // A redelivery of an open exception is acknowledged, not reprocessed or 409'd.
      await expect(
        deliverWithId(id, 'shop/redact', { shop_id: 1, shop_domain: shop }),
      ).resolves.toBeUndefined();
      expect((await auditRow(id)).attempts).toBe(1);

      await compliance.resolve(id, 'Store never connected to BRAYN; nothing held.');
      expect(await auditRow(id)).toMatchObject({
        status: 'resolved',
        payload: null,
        resolutionNote: 'Store never connected to BRAYN; nothing held.',
      });
    });
  });

  describe('stable shop identity (Shopify numeric shop_id)', () => {
    const deliverWithId = (webhookId: string, topic: string, payload: object) => {
      const body = JSON.stringify(payload);
      return compliance.handle(topic, body, {
        'x-shopify-hmac-sha256': sign(body),
        'x-shopify-webhook-id': webhookId,
      });
    };
    const auditRow = async (webhookId: string) =>
      (
        await db.client
          .select()
          .from(shopifyComplianceWebhooks)
          .where(eq(shopifyComplianceWebhooks.webhookId, webhookId))
      )[0];
    const newShopId = () => String(1_000_000 + Math.floor(Math.random() * 1e9));

    it('a compliance request under a changed domain alias still reaches the store by shop_id', async () => {
      const a = await workspace();
      const [oldDomain, alias, shopId] = [newShop(), newShop(), newShopId()];
      expect(await service.connectStore(a, 'shopify', creds(oldDomain), shopId)).toBe('ok');
      await addCustomer(a, 'c-1');
      const id = `wh-${randomUUID()}`;
      await deliverWithId(id, 'customers/redact', {
        shop_id: Number(shopId),
        shop_domain: alias,
        customer: { id: 'c-1' },
      });
      expect(await customerCount(a)).toBe(0);
      expect(await auditRow(id)).toMatchObject({
        status: 'processed',
        outcome: 'erased',
        matchedIntegrations: 1,
      });
    });

    it('a legacy row (no shop id) resolved by domain learns its shop id, so a later alias delivery still finds it', async () => {
      const a = await workspace();
      const [domain, alias, shopId] = [newShop(), newShop(), newShopId()];
      expect(await oauth(a, domain)).toBe('ok'); // legacy: connected without a shop id
      expect((await row(a)).shopifyShopId).toBeNull();
      await addCustomer(a, 'c-1');
      await addCustomer(a, 'c-2');

      await deliverWithId(`wh-${randomUUID()}`, 'customers/redact', {
        shop_id: shopId,
        shop_domain: domain,
        customer: { id: 'c-1' },
      });
      expect((await row(a)).shopifyShopId).toBe(shopId);
      await deliverWithId(`wh-${randomUUID()}`, 'customers/redact', {
        shop_id: shopId,
        shop_domain: alias,
        customer: { id: 'c-2' },
      });
      expect(await customerCount(a)).toBe(0);
    });

    it('a domain that now belongs to a different store id is NOT erased and raises an identity_conflict exception', async () => {
      const a = await workspace();
      const [domain, shopId] = [newShop(), newShopId()];
      expect(await service.connectStore(a, 'shopify', creds(domain), shopId)).toBe('ok');
      await addCustomer(a, 'c-1');
      const id = `wh-${randomUUID()}`;
      await deliverWithId(id, 'shop/redact', { shop_id: newShopId(), shop_domain: domain });
      expect(await customerCount(a)).toBe(1);
      expect((await row(a)).status).toBe('connected');
      expect(await auditRow(id)).toMatchObject({
        status: 'exception',
        exceptionReason: 'identity_conflict',
        matchedIntegrations: 0,
      });
    });

    it('legacy holder + id holder for one request: both erased; a same-domain row with another id is a conflict, untouched', async () => {
      const [legacy, byId, other] = [await workspace(), await workspace(), await workspace()];
      const [domain, alias, shopId] = [newShop(), newShop(), newShopId()];
      expect(await oauth(legacy, domain)).toBe('ok');
      await addCustomer(legacy, 'c-1');
      await service.disconnect(legacy, 'shopify');
      // `other`: historical row on the same domain but a different store id (disconnected, retained data).
      await service.connect(other, 'shopify');
      await db.client
        .update(integrations)
        .set({ shopDomain: domain, shopifyShopId: newShopId(), status: 'disconnected' })
        .where(eq(integrations.id, (await row(other)).id));
      await addCustomer(other, 'c-1');
      expect(await service.connectStore(byId, 'shopify', creds(alias), shopId)).toBe('ok');
      await addCustomer(byId, 'c-1');

      const id = `wh-${randomUUID()}`;
      await deliverWithId(id, 'customers/redact', {
        shop_id: shopId,
        shop_domain: domain,
        customer: { id: 'c-1' },
      });
      expect(await customerCount(legacy)).toBe(0);
      expect(await customerCount(byId)).toBe(0);
      expect(await customerCount(other)).toBe(1);
      expect(await auditRow(id)).toMatchObject({
        status: 'exception',
        exceptionReason: 'identity_conflict',
        matchedIntegrations: 2,
      });
    });

    it('an unresolved delivery is recoverable: once the store identity is known, replay processes it from the stored payload', async () => {
      const a = await workspace();
      const [domain, alias, shopId] = [newShop(), newShop(), newShopId()];
      expect(await oauth(a, domain)).toBe('ok'); // legacy row, no shop id
      await addCustomer(a, 'c-1');
      const id = `wh-${randomUUID()}`;
      await deliverWithId(id, 'customers/redact', {
        shop_id: shopId,
        shop_domain: alias,
        customer: { id: 'c-1' },
      });
      expect(await auditRow(id)).toMatchObject({
        status: 'exception',
        exceptionReason: 'unknown_shop',
      });
      expect(await customerCount(a)).toBe(1);

      expect(await service.recordShopifyShopId([(await row(a)).id], shopId)).toBe('ok'); // ops backfill
      expect(await compliance.replay(id)).toEqual({ status: 'processed' });
      expect(await customerCount(a)).toBe(0);
      expect(await auditRow(id)).toMatchObject({ status: 'processed', payload: null, attempts: 2 });
    });

    it('a superseded attempt (claim retaken after a timeout) cannot mark the delivery done or commit data-request records', async () => {
      const a = await workspace();
      const [domain, shopId] = [newShop(), newShopId()];
      expect(await service.connectStore(a, 'shopify', creds(domain), shopId)).toBe('ok');
      const id = `wh-${randomUUID()}`;
      const original = service.resolveShopHolders.bind(service);
      const spy = vi
        .spyOn(service, 'resolveShopHolders')
        .mockImplementationOnce(async (...args) => {
          // A newer attempt takes the claim while this one is still running.
          await db.client
            .update(shopifyComplianceWebhooks)
            .set({ attempts: sql`${shopifyComplianceWebhooks.attempts} + 1` })
            .where(eq(shopifyComplianceWebhooks.webhookId, id));
          return original(...args);
        });
      await expect(
        deliverWithId(id, 'customers/data_request', {
          shop_id: shopId,
          shop_domain: domain,
          customer: { id: 7 },
        }),
      ).rejects.toBeInstanceOf(ConflictError);
      spy.mockRestore();
      const records = await db.client
        .select({ id: customerDataRequests.id })
        .from(customerDataRequests)
        .where(eq(customerDataRequests.workspaceId, a));
      expect(records).toHaveLength(0);
      expect(await auditRow(id)).toMatchObject({ status: 'processing', attempts: 2 });
    });

    it('app/uninstalled under a domain alias disconnects the store by its shop id', async () => {
      const a = await workspace();
      const [domain, alias, shopId] = [newShop(), newShop(), newShopId()];
      expect(await service.connectStore(a, 'shopify', creds(domain), shopId)).toBe('ok');
      const body = JSON.stringify({ id: Number(shopId), myshopify_domain: alias });
      await uninstall.handle(body, {
        'x-shopify-topic': 'app/uninstalled',
        'x-shopify-shop-domain': alias,
        'x-shopify-hmac-sha256': sign(body),
      });
      expect((await row(a)).status).toBe('disconnected');
    });

    it('the ownership invariant holds by shop id too: the same store under another domain cannot go live twice', async () => {
      const [a, b] = [await workspace(), await workspace()];
      const shopId = newShopId();
      expect(await service.connectStore(a, 'shopify', creds(newShop()), shopId)).toBe('ok');
      expect(await service.prepareStoreConnection(b, 'shopify', newShop(), shopId)).toBe(
        'owned_elsewhere',
      );
      expect(await service.connectStore(b, 'shopify', creds(newShop()), shopId)).toBe(
        'owned_elsewhere',
      );
      expect(await row(b)).toBeUndefined();
    });
  });

  describe('compliance payload protection and retention', () => {
    const deliverWithId = (webhookId: string, topic: string, payload: object) => {
      const body = JSON.stringify(payload);
      return compliance.handle(topic, body, {
        'x-shopify-hmac-sha256': sign(body),
        'x-shopify-webhook-id': webhookId,
      });
    };
    const auditRow = async (webhookId: string) =>
      (
        await db.client
          .select()
          .from(shopifyComplianceWebhooks)
          .where(eq(shopifyComplianceWebhooks.webhookId, webhookId))
      )[0];
    const age = (webhookId: string, days: number) =>
      db.client
        .update(shopifyComplianceWebhooks)
        .set({ receivedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) })
        .where(eq(shopifyComplianceWebhooks.webhookId, webhookId));

    it('an unresolved payload is stored encrypted (no customer identifier in the row) and still replayable', async () => {
      const id = `wh-${randomUUID()}`;
      await deliverWithId(id, 'customers/redact', {
        shop_id: 77,
        shop_domain: newShop(),
        customer: { id: 191167, email: 'jane@example.com', phone: '+15556251199' },
        orders_to_redact: [299938],
      });
      const r = await auditRow(id);
      expect(r.status).toBe('exception');
      expect(r.payload).toMatchObject({ v: 1, ciphertext: expect.any(String) });
      const raw = JSON.stringify(r);
      for (const secret of ['jane@example.com', '191167', '+15556251199', '299938'])
        expect(raw).not.toContain(secret);
      // Decrypts for replay (still unresolvable here, so it stays an open exception).
      expect(await compliance.replay(id)).toEqual({ status: 'exception' });
    });

    it('after 30 days an unresolved payload is cleared but the delivery stays open, escalated and visibly unreplayable', async () => {
      const [old, recent] = [`wh-${randomUUID()}`, `wh-${randomUUID()}`];
      await deliverWithId(old, 'shop/redact', { shop_id: 78, shop_domain: newShop() });
      await deliverWithId(recent, 'shop/redact', { shop_id: 79, shop_domain: newShop() });
      await age(old, 31);
      await age(recent, 8);

      const result = await applyCompliancePayloadRetention(db.client, new Date());
      expect(result.compliancePayloadsCleared).toBeGreaterThanOrEqual(1);
      expect(result.complianceOverdue).toBeGreaterThanOrEqual(2);
      expect(result.complianceNearDeadline).toBeGreaterThanOrEqual(1);
      expect(await auditRow(old)).toMatchObject({ status: 'exception', payload: null });
      expect((await auditRow(recent)).payload).not.toBeNull();
      await expect(compliance.replay(old)).rejects.toBeInstanceOf(NotFoundError);
      const open = await compliance.openIssues();
      expect(open.payloadExpired).toBeGreaterThanOrEqual(1);
      expect(open.nearDeadline).toBeGreaterThanOrEqual(1);

      await compliance.resolve(old, 'Deadline handled manually.');
      await compliance.resolve(recent, 'Test cleanup.');
    });
  });
});
