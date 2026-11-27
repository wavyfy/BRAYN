import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray } from 'drizzle-orm';
import { AppModule } from '../../../../app.module';
import { DatabaseService } from '../../../../database/database.service';
import { workspaces } from '../../../../database/schema/workspaces';
import { integrations } from '../../../../database/schema/integrations';
import { CredentialRevokedError, ProviderError } from '../../../../common/errors/app-error';
import { IntegrationService } from '../../integration.service';
import { ShopifyCredentialKeepAliveService } from './shopify-credential-keepalive.service';
import { complianceOpenIssueCounts } from './shopify-compliance-retention';

/**
 * Shopify offline-token lifecycle against the real dev DB, with Shopify's token + GraphQL endpoints faked at `fetch`
 * (modelled on shopify.dev: 1h access token, 90-day refresh token rotated on every refresh, 401 = final).
 * Two independent Nest apps (two connection pools) stand in for two backend instances on one database.
 */
describe('Shopify credential lifecycle (real DB)', { timeout: 120_000 }, () => {
  let appA: TestingModule;
  let appB: TestingModule;
  let db: DatabaseService;
  let serviceA: IntegrationService;
  let serviceB: IntegrationService;
  let keepAlive: ShopifyCredentialKeepAliveService;
  const workspaceIds: string[] = [];

  type FakeShop = {
    mode: 'ok' | '401' | '500';
    delayMs: number;
    presented: string[];
    issued: number;
    graphql: number;
    shopId: string;
    myshopifyDomain: string;
    duringRefresh?: () => Promise<unknown>;
  };
  let shops: Map<string, FakeShop>;
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  beforeAll(async () => {
    appA = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await appA.init();
    appB = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await appB.init();
    db = appA.get(DatabaseService);
    if (!db.isConfigured())
      throw new Error('DATABASE_URL is not configured — this test requires the real dev database.');
    serviceA = appA.get(IntegrationService);
    serviceB = appB.get(IntegrationService);
    keepAlive = appA.get(ShopifyCredentialKeepAliveService);
  }, 120_000);

  beforeEach(() => {
    shops = new Map();
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const shop = shops.get(url.hostname);
      if (!shop) throw new Error(`unexpected fetch to ${url.hostname}`);
      if (url.pathname === '/admin/oauth/access_token') {
        const form = new URLSearchParams(String(init?.body));
        shop.presented.push(form.get('refresh_token') ?? '');
        await new Promise((r) => setTimeout(r, shop.delayMs));
        await shop.duringRefresh?.();
        if (shop.mode === '401')
          return Response.json({ error: 'invalid_request' }, { status: 401 });
        if (shop.mode === '500') return new Response('upstream', { status: 500 });
        shop.issued++;
        return Response.json({
          access_token: `shpat_new_${shop.issued}`,
          refresh_token: `shprt_new_${shop.issued}`,
          expires_in: 3600,
          refresh_token_expires_in: 7_776_000,
          scope: 'read_customers',
        });
      }
      if (url.pathname.endsWith('/graphql.json')) {
        shop.graphql++;
        return Response.json({
          data: {
            shop: {
              id: `gid://shopify/Shop/${shop.shopId}`,
              myshopifyDomain: shop.myshopifyDomain,
            },
          },
        });
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    if (db?.isConfigured() && workspaceIds.length > 0) {
      await db.client.delete(integrations).where(inArray(integrations.workspaceId, workspaceIds));
      await db.client.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
    }
    await appB?.close();
    await appA?.close();
  }, 60_000);

  const newShop = (fake: Partial<FakeShop> = {}) => {
    const domain = `lifecycle-${randomUUID().slice(0, 8)}.myshopify.com`;
    shops.set(domain, {
      mode: 'ok',
      delayMs: 0,
      presented: [],
      issued: 0,
      graphql: 0,
      shopId: String(Math.floor(Math.random() * 1e12)),
      myshopifyDomain: domain,
      ...fake,
    });
    return { domain, fake: shops.get(domain)! };
  };

  /** A connected Shopify store with an authorization-code credential (defaults: access token expired 1h ago). */
  async function store(domain: string, credentials: Record<string, string> = {}, shopId?: string) {
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    await db.client
      .insert(workspaces)
      .values({ id: workspaceId, name: 'Credential lifecycle spec' });
    expect(
      await serviceA.connectStore(
        workspaceId,
        'shopify',
        {
          shopDomain: domain,
          accessToken: 'shpat_old',
          refreshToken: 'shprt_old',
          grantType: 'authorization_code',
          expiresAt: new Date(Date.now() - HOUR).toISOString(),
          ...credentials,
        },
        shopId,
      ),
    ).toBe('ok');
    return workspaceId;
  }

  const row = async (workspaceId: string) =>
    (
      await db.client
        .select()
        .from(integrations)
        .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'shopify')))
    )[0];
  const stored = (workspaceId: string) => serviceA.getStoredCredentials(workspaceId, 'shopify');

  it('concurrent refreshes from two backend instances make exactly one Shopify refresh; everyone gets the new token', async () => {
    const { domain, fake } = newShop({ delayMs: 2_000 });
    const ws = await store(domain);
    // Open several connections in each app first, so the four refreshes really overlap (a cold Neon connection takes
    // about a second to open, which would otherwise serialize them by accident).
    await Promise.all(
      [db, appB.get(DatabaseService)].flatMap((d) => Array.from({ length: 4 }, () => d.ping())),
    );
    const results = await Promise.all([
      serviceA.getCredentials(ws, 'shopify'),
      serviceB.getCredentials(ws, 'shopify'),
      serviceA.getCredentials(ws, 'shopify'),
      serviceB.getCredentials(ws, 'shopify'),
    ]);
    expect(fake.presented).toEqual(['shprt_old']);
    expect(results.map((c) => c?.accessToken)).toEqual(Array(4).fill('shpat_new_1'));
    expect(await stored(ws)).toMatchObject({
      accessToken: 'shpat_new_1',
      refreshToken: 'shprt_new_1',
    });
    const r = await row(ws);
    expect(r.credentialRenewalError).toBeNull();
    expect(
      Math.abs(r.credentialRefreshExpiresAt!.getTime() - (Date.now() + 90 * DAY)),
    ).toBeLessThan(60_000);
    expect(r.status).toBe('connected');
  });

  it('Shopify 401: credential untouched, store stays connected, flagged; later reads fail fast without calling Shopify; reconnect clears it', async () => {
    const { domain, fake } = newShop({ mode: '401' });
    const ws = await store(domain);
    const before = (await row(ws)).credentials;
    await expect(serviceA.getCredentials(ws, 'shopify')).rejects.toBeInstanceOf(
      CredentialRevokedError,
    );
    let r = await row(ws);
    expect(r.credentials).toBe(before);
    expect(r).toMatchObject({
      status: 'connected',
      credentialRenewalError: 'reauthorization_required',
    });

    await expect(serviceB.getCredentials(ws, 'shopify')).rejects.toBeInstanceOf(
      CredentialRevokedError,
    );
    expect(fake.presented).toHaveLength(1);
    expect(
      (await complianceOpenIssueCounts(db.client, new Date())).credentials.reauthorizationRequired,
    ).toBeGreaterThanOrEqual(1);

    // Merchant reconnects (OAuth stores a fresh credential): the flag clears and refresh works again.
    await serviceA.connectStore(ws, 'shopify', {
      shopDomain: domain,
      accessToken: 'shpat_reauth',
      refreshToken: 'shprt_reauth',
      grantType: 'authorization_code',
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 90 * DAY).toISOString(),
    });
    r = await row(ws);
    expect(r.credentialRenewalError).toBeNull();
    expect(r.credentialRefreshExpiresAt).not.toBeNull();
  });

  it('transient Shopify failure: credential untouched, flagged renewal_failed, the next success presents the same refresh token and clears it', async () => {
    const { domain, fake } = newShop({ mode: '500' });
    const ws = await store(domain);
    const before = (await row(ws)).credentials;
    await expect(serviceA.getCredentials(ws, 'shopify')).rejects.toBeInstanceOf(ProviderError);
    expect(await row(ws)).toMatchObject({
      credentials: before,
      status: 'connected',
      credentialRenewalError: 'renewal_failed',
    });

    fake.mode = 'ok';
    expect((await serviceA.getCredentials(ws, 'shopify'))?.accessToken).toBe('shpat_new_1');
    expect(fake.presented).toEqual(['shprt_old', 'shprt_old']);
    expect((await row(ws)).credentialRenewalError).toBeNull();
  });

  it('refresh succeeded but persisting failed: stored credential unchanged; the retry presents the old (still valid) refresh token', async () => {
    const { domain, fake } = newShop();
    const ws = await store(domain);
    const before = (await row(ws)).credentials;
    const columns = vi
      .spyOn(
        serviceA as unknown as { credentialColumns: (c: Record<string, string>) => unknown },
        'credentialColumns',
      )
      .mockImplementationOnce(() => {
        throw new Error('simulated write failure');
      });
    await expect(serviceA.getCredentials(ws, 'shopify')).rejects.toThrow('simulated write failure');
    columns.mockRestore();
    expect((await row(ws)).credentials).toBe(before);
    expect((await serviceA.getCredentials(ws, 'shopify'))?.refreshToken).toBe('shprt_new_2');
    expect(fake.presented).toEqual(['shprt_old', 'shprt_old']);
  });

  it('a reconnect that lands during an in-flight refresh wins: the refresh never overwrites it, and no stale failure flag', async () => {
    const oauth = (shopDomain: string) => ({
      shopDomain,
      accessToken: 'shpat_oauth',
      refreshToken: 'shprt_oauth',
      grantType: 'authorization_code',
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
      refreshTokenExpiresAt: new Date(Date.now() + 90 * DAY).toISOString(),
    });
    // The reconnect commits (on the other backend) while Shopify is still answering the refresh — deterministic.
    const { domain, fake } = newShop();
    const ws = await store(domain);
    fake.duringRefresh = () => serviceB.connectStore(ws, 'shopify', oauth(domain));
    expect((await serviceA.getCredentials(ws, 'shopify'))?.accessToken).toBe('shpat_oauth');
    expect(await stored(ws)).toMatchObject({
      accessToken: 'shpat_oauth',
      refreshToken: 'shprt_oauth',
    });

    // A refusal of the OLD lineage after a reconnect must not flag the new credential.
    const { domain: d2, fake: f2 } = newShop({ mode: '401' });
    const ws2 = await store(d2);
    f2.duringRefresh = () => serviceB.connectStore(ws2, 'shopify', oauth(d2));
    await expect(serviceA.getCredentials(ws2, 'shopify')).rejects.toBeInstanceOf(
      CredentialRevokedError,
    );
    expect(f2.presented).toEqual(['shprt_old']);
    expect(await row(ws2)).toMatchObject({ credentialRenewalError: null, status: 'connected' });
  });

  it('keep-alive: a legacy credential (unknown expiry, no shop id) gets one refresh + one identity read, then nothing more', async () => {
    const { domain, fake } = newShop();
    const ws = await store(domain, { expiresAt: new Date(Date.now() - HOUR).toISOString() });
    expect((await row(ws)).credentialRefreshExpiresAt).toBeNull();

    const counts = await keepAlive.run(new Date(), { workspaceIds: [ws] });
    expect(counts).toMatchObject({
      due: 1,
      renewed: 1,
      shopIdsRecorded: 1,
      aliasesRecorded: 0,
      failed: 0,
    });
    expect(fake.presented).toEqual(['shprt_old']);
    expect(fake.graphql).toBe(1);
    const r = await row(ws);
    expect(r.shopifyShopId).toBe(fake.shopId);
    expect(r.credentialRefreshExpiresAt).not.toBeNull();
    expect(r.shopDomainAliases).toEqual([]);

    expect(await keepAlive.run(new Date(), { workspaceIds: [ws] })).toMatchObject({ due: 0 });
    expect(fake.presented).toHaveLength(1);
    expect(fake.graphql).toBe(1);
  });

  it('keep-alive: renews a refresh token within 30 days of expiry even when the access token is fresh; leaves a distant one alone', async () => {
    const { domain: near, fake: nearFake } = newShop();
    const { domain: far, fake: farFake } = newShop();
    const fresh = { expiresAt: new Date(Date.now() + HOUR).toISOString() };
    const wsNear = await store(
      near,
      { ...fresh, refreshTokenExpiresAt: new Date(Date.now() + 20 * DAY).toISOString() },
      nearFake.shopId,
    );
    const wsFar = await store(
      far,
      { ...fresh, refreshTokenExpiresAt: new Date(Date.now() + 60 * DAY).toISOString() },
      farFake.shopId,
    );

    const counts = await keepAlive.run(new Date(), { workspaceIds: [wsNear, wsFar] });
    expect(counts).toMatchObject({ due: 1, renewed: 1, shopIdsRecorded: 0 });
    expect(nearFake.presented).toEqual(['shprt_old']);
    expect(nearFake.graphql).toBe(0);
    expect(farFake.presented).toEqual([]);
    expect((await row(wsNear)).credentialRefreshExpiresAt!.getTime()).toBeGreaterThan(
      Date.now() + 89 * DAY,
    );
  });

  it("keep-alive: records Shopify's own myshopifyDomain as an alias — but never one another workspace holds", async () => {
    const renamed = `lifecycle-${randomUUID().slice(0, 8)}.myshopify.com`;
    const { domain, fake } = newShop({ myshopifyDomain: renamed });
    const ws = await store(domain);
    expect(await keepAlive.run(new Date(), { workspaceIds: [ws] })).toMatchObject({
      shopIdsRecorded: 1,
      aliasesRecorded: 1,
    });
    expect((await row(ws)).shopDomainAliases).toEqual([renamed]);

    const { domain: other } = newShop();
    const { domain: second, fake: secondFake } = newShop({ myshopifyDomain: other });
    await store(
      other,
      { expiresAt: new Date(Date.now() + HOUR).toISOString() },
      String(Date.now()),
    );
    const ws2 = await store(second);
    expect(await keepAlive.run(new Date(), { workspaceIds: [ws2] })).toMatchObject({
      shopIdsRecorded: 1,
      aliasesRecorded: 0,
      identityConflicts: 1,
    });
    expect((await row(ws2)).shopDomainAliases).toEqual([]);
    expect(secondFake.graphql).toBe(1);
    expect(fake.graphql).toBe(1);
  });

  it('keep-alive: a shop id another live connection already has is a conflict, never written', async () => {
    const { domain: first, fake: firstFake } = newShop();
    await store(first, { expiresAt: new Date(Date.now() + HOUR).toISOString() }, firstFake.shopId);
    const { domain: dup } = newShop({ shopId: firstFake.shopId });
    const ws = await store(dup);
    expect(await keepAlive.run(new Date(), { workspaceIds: [ws] })).toMatchObject({
      identityConflicts: 1,
      shopIdsRecorded: 0,
    });
    expect((await row(ws)).shopifyShopId).toBeNull();
  });

  it('keep-alive: skips a connection Shopify refused (no call), and counts a fresh refusal without disconnecting', async () => {
    const { domain, fake } = newShop({ mode: '401' });
    const ws = await store(domain);
    expect(await keepAlive.run(new Date(), { workspaceIds: [ws] })).toMatchObject({
      reauthorizationRequired: 1,
      failed: 0,
    });
    expect(await keepAlive.run(new Date(), { workspaceIds: [ws] })).toMatchObject({
      reauthorizationRequired: 1,
    });
    expect(fake.presented).toHaveLength(1);
    expect((await row(ws)).status).toBe('connected');
  });

  it('keep-alive: a client-credentials connection with a shop id and no refresh token makes no Shopify call', async () => {
    const { domain, fake } = newShop();
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    await db.client
      .insert(workspaces)
      .values({ id: workspaceId, name: 'Credential lifecycle spec' });
    await serviceA.connectStore(
      workspaceId,
      'shopify',
      {
        shopDomain: domain,
        accessToken: 'shpat_cc',
        grantType: 'client_credentials',
        expiresAt: new Date(Date.now() - HOUR).toISOString(),
      },
      fake.shopId,
    );
    expect(await keepAlive.run(new Date(), { workspaceIds: [workspaceId] })).toMatchObject({
      due: 1,
      renewed: 0,
      failed: 0,
    });
    expect(fake.presented).toEqual([]);
    expect(fake.graphql).toBe(0);
  });
});
