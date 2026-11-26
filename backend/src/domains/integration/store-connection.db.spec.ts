import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { integrations } from '../../database/schema/integrations';
import { integrationImportRuns } from '../../database/schema/integration-import-runs';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { IntegrationService } from './integration.service';
import { ImportRunService } from './import-run.service';

/**
 * Onboarding v1 review: the Shopify connection row is reused across reconnects, so a previous connection's import
 * must never count for a new one, and two stores' data must never be mixed under one connection (real dev DB).
 */
describe('IntegrationService.prepareStoreConnection (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let service: IntegrationService;
  let importRuns: ImportRunService;
  const workspaceIds: string[] = [];
  // Unique per run: one store can be live in only one workspace (migration 0053), so fixed domains would collide.
  const run = randomUUID().slice(0, 8);
  const d = (name: string) => `${name}-${run}.myshopify.com`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured())
      throw new Error(
        'DATABASE_URL is not configured — this integration test requires the real dev database.',
      );
    service = moduleRef.get(IntegrationService);
    importRuns = moduleRef.get(ImportRunService);
  }, 60_000);

  afterAll(async () => {
    if (db?.isConfigured() && workspaceIds.length > 0) {
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

  /** A workspace whose Shopify connection last held `shop`, with one succeeded import run. */
  async function connectedWorkspace(
    shop: string,
    opts: { disconnected?: boolean; withData?: boolean } = {},
  ) {
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    await db.client.insert(workspaces).values({ id: workspaceId, name: 'Store connection spec' });
    const integration = await service.connect(workspaceId, 'shopify');
    await service.setCredentials(workspaceId, 'shopify', {
      shopDomain: shop,
      accessToken: 'shpat_test',
    });
    await db.client
      .insert(integrationImportRuns)
      .values({
        workspaceId,
        integrationId: integration.id,
        status: 'succeeded',
        completedAt: new Date(),
      });
    if (opts.withData) {
      await db.client
        .insert(commerceCustomers)
        .values({
          workspaceId,
          integrationId: integration.id,
          provider: 'shopify',
          externalId: 'c-1',
        });
    }
    if (opts.disconnected) await service.disconnect(workspaceId, 'shopify');
    return workspaceId;
  }
  const runCount = async (workspaceId: string) =>
    (
      await db.client
        .select()
        .from(integrationImportRuns)
        .where(eq(integrationImportRuns.workspaceId, workspaceId))
    ).length;

  it('no existing connection → ok', async () => {
    const workspaceId = randomUUID();
    workspaceIds.push(workspaceId);
    await db.client.insert(workspaces).values({ id: workspaceId, name: 'Store connection spec' });
    expect(await service.prepareStoreConnection(workspaceId, 'shopify', d('any'))).toBe(
      'ok',
    );
  });

  it('re-authorizing the same live store keeps its import history (onboarding stays complete)', async () => {
    const workspaceId = await connectedWorkspace(d('same'), { withData: true });
    expect(await service.prepareStoreConnection(workspaceId, 'shopify', d('same').toUpperCase())).toBe(
      'ok',
    );
    expect(await runCount(workspaceId)).toBe(1);
    expect((await importRuns.getLatestImportRun(workspaceId, 'shopify'))?.status).toBe('succeeded');
  });

  it('reconnecting after a disconnect clears the previous import, so onboarding requires a fresh import', async () => {
    const workspaceId = await connectedWorkspace(d('back'), {
      disconnected: true,
      withData: true,
    });
    expect(await service.prepareStoreConnection(workspaceId, 'shopify', d('back'))).toBe(
      'ok',
    );
    // The check alone clears nothing; the accepted connection does.
    expect(await runCount(workspaceId)).toBe(1);
    expect(
      await service.connectStore(workspaceId, 'shopify', { shopDomain: d('back'), accessToken: 'shpat_new' }),
    ).toBe('ok');
    expect(await runCount(workspaceId)).toBe(0);
    expect(await importRuns.getLatestImportRun(workspaceId, 'shopify')).toBeNull();
  });

  it("a different store is refused while the previous store's data is still held (live or disconnected), and nothing is cleared", async () => {
    const live = await connectedWorkspace(d('first'), { withData: true });
    const parked = await connectedWorkspace(d('first-parked'), {
      withData: true,
      disconnected: true,
    });
    for (const workspaceId of [live, parked]) {
      expect(
        await service.prepareStoreConnection(workspaceId, 'shopify', d('second')),
      ).toBe('different_store');
      expect(await runCount(workspaceId)).toBe(1);
    }
  });

  it('a different store with no data left from the previous one is allowed, with the old import cleared', async () => {
    const workspaceId = await connectedWorkspace(d('empty'), { disconnected: true });
    expect(
      await service.prepareStoreConnection(workspaceId, 'shopify', d('another')),
    ).toBe('ok');
    expect(
      await service.connectStore(workspaceId, 'shopify', { shopDomain: d('another'), accessToken: 'shpat_new' }),
    ).toBe('ok');
    expect(await runCount(workspaceId)).toBe(0);
  });

  it('a connect refused by the store-ownership index clears nothing (the reset rolls back with it)', async () => {
    const owner = randomUUID();
    workspaceIds.push(owner);
    await db.client.insert(workspaces).values({ id: owner, name: 'Store connection spec' });
    expect(await service.connectStore(owner, 'shopify', { shopDomain: d('contested'), accessToken: 'shpat_a' })).toBe('ok');
    const loser = await connectedWorkspace(d('loser'), { disconnected: true });
    expect(
      await service.connectStore(loser, 'shopify', { shopDomain: d('contested'), accessToken: 'shpat_b' }),
    ).toBe('owned_elsewhere');
    expect(await runCount(loser)).toBe(1);
  });
});
