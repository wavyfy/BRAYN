import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../../config/env.schema';
import type { DatabaseService } from '../../../../database/database.service';
import type { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import type { IntegrationService } from '../../integration.service';
import {
  shopifyManagedWebhookSubscriptions,
  shopifyTopicEnum,
  type ShopifyAdapter,
  type ShopifyWebhookSubscription,
} from './shopify.adapter';
import {
  planWebhookSubscriptionMigration,
  ShopifyWebhookMigrationService,
} from './shopify-webhook-migration.service';

const OLD = 'https://brayn-production.onrender.com';
const NEW = 'https://brayn-ohio.onrender.com';
const WS_A = '11111111-1111-4111-8111-111111111111';
const WS_B = '22222222-2222-4222-8222-222222222222';

function sub(
  id: string,
  topic: string,
  uri: string,
  extra: Partial<ShopifyWebhookSubscription> = {},
): ShopifyWebhookSubscription {
  return {
    id,
    topic: shopifyTopicEnum(topic),
    uri,
    filter: null,
    format: 'JSON',
    includeFields: [],
    metafieldNamespaces: [],
    name: null,
    ...extra,
  };
}

/** In-memory Shopify store: ids are stable across updates, like Shopify's in-place webhookSubscriptionUpdate. */
class FakeShop {
  private nextId = 1000;
  updates: { id: string; input: Record<string, unknown> }[] = [];
  mutations = 0;
  failUpdateFor = new Set<string>();
  failCreate = false;

  constructor(public subs: ShopifyWebhookSubscription[]) {}

  adapterPart() {
    return {
      listWebhookSubscriptions: async (_c: Record<string, string>, topics: string[]) =>
        this.subs.filter((s) => topics.includes(s.topic)).map((s) => ({ ...s })),
      updateWebhookSubscriptionUri: async (
        _c: Record<string, string>,
        s: ShopifyWebhookSubscription,
        uri: string,
      ) => {
        this.mutations++;
        if (this.failUpdateFor.has(s.topic))
          throw new Error('Shopify refused the webhook subscription update: throttled');
        const target = this.subs.find((x) => x.id === s.id)!;
        this.updates.push({
          id: s.id,
          input: {
            uri,
            filter: s.filter,
            format: s.format,
            includeFields: s.includeFields,
            metafieldNamespaces: s.metafieldNamespaces,
            name: s.name,
          },
        });
        target.uri = uri;
      },
      createWebhookSubscription: async (
        _c: Record<string, string>,
        topicEnum: string,
        uri: string,
      ) => {
        this.mutations++;
        if (this.failCreate) return 'Access denied';
        this.subs.push({ ...sub(`gid://${this.nextId++}`, 'x/y', uri), topic: topicEnum });
        return null;
      },
      deleteWebhookSubscription: async (_c: Record<string, string>, id: string) => {
        this.mutations++;
        this.subs = this.subs.filter((s) => s.id !== id);
      },
    };
  }
}

function managed(backendUrl: string, workspaceId: string) {
  return shopifyManagedWebhookSubscriptions(backendUrl, workspaceId).map((d, i) =>
    sub(`gid://${workspaceId.slice(0, 1)}${i}`, d.topic, d.uri),
  );
}

function makeService(opts: {
  backendUrl: string;
  shops: Record<string, FakeShop | Error>;
  workspaces?: string[];
  lockFree?: boolean;
}) {
  const workspaces = opts.workspaces ?? Object.keys(opts.shops);
  let currentWorkspace = '';
  const where = vi.fn(async () => workspaces.map((workspaceId) => ({ workspaceId })));
  const lockQueries: unknown[] = [];
  const database = {
    client: { select: () => ({ from: () => ({ where }) }) },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: async (query: unknown) => {
          lockQueries.push(query);
          return { rows: [{ locked: opts.lockFree ?? true }] };
        },
      }),
  } as unknown as DatabaseService;
  const integrationService = {
    getCredentials: vi.fn(async (workspaceId: string) => {
      currentWorkspace = workspaceId;
      const shop = opts.shops[workspaceId];
      if (shop instanceof Error) throw shop;
      return { shopDomain: `${workspaceId}.myshopify.com`, accessToken: 'shpat_x' };
    }),
  } as unknown as IntegrationService;
  const shopFor = () => opts.shops[currentWorkspace] as FakeShop;
  const adapter = {
    listWebhookSubscriptions: (...a: [Record<string, string>, string[]]) =>
      shopFor()
        .adapterPart()
        .listWebhookSubscriptions(...a),
    updateWebhookSubscriptionUri: (
      ...a: [Record<string, string>, ShopifyWebhookSubscription, string]
    ) =>
      shopFor()
        .adapterPart()
        .updateWebhookSubscriptionUri(...a),
    createWebhookSubscription: (...a: [Record<string, string>, string, string]) =>
      shopFor()
        .adapterPart()
        .createWebhookSubscription(...a),
    deleteWebhookSubscription: (...a: [Record<string, string>, string]) =>
      shopFor()
        .adapterPart()
        .deleteWebhookSubscription(...a),
  } as unknown as ShopifyAdapter;
  const config = { get: () => opts.backendUrl } as unknown as ConfigService<Env, true>;
  const logger = { event: vi.fn() } as unknown as StructuredLoggerService;
  return {
    service: new ShopifyWebhookMigrationService(
      database,
      integrationService,
      adapter,
      config,
      logger,
    ),
    where,
    lockQueries,
  };
}

const TOPIC_COUNT = shopifyManagedWebhookSubscriptions(OLD, WS_A).length;
const managedUris = (backendUrl: string, ws: string) =>
  new Set(shopifyManagedWebhookSubscriptions(backendUrl, ws).map((d) => d.uri));

describe('planWebhookSubscriptionMigration', () => {
  const move = {
    topic: 'orders/create',
    fromUri: `${OLD}/api/v1/workspaces/${WS_A}/integrations/shopify/webhooks`,
    toUri: `${NEW}/api/v1/workspaces/${WS_A}/integrations/shopify/webhooks`,
  };

  it('updates the source subscription in place (same id) when the target has none', () => {
    const source = sub('gid://1', 'orders/create', move.fromUri);
    expect(planWebhookSubscriptionMigration([source], [move])).toEqual([
      { kind: 'update', topic: 'orders/create', subscription: source, toUri: move.toUri },
    ]);
  });

  it('keeps an existing target subscription and deletes source copies and target duplicates', () => {
    const plan = planWebhookSubscriptionMigration(
      [
        sub('gid://t1', 'orders/create', move.toUri),
        sub('gid://t2', 'orders/create', move.toUri),
        sub('gid://s1', 'orders/create', move.fromUri),
      ],
      [move],
    );
    expect(plan).toEqual([
      { kind: 'keep', topic: 'orders/create', subscriptionId: 'gid://t1' },
      { kind: 'delete', topic: 'orders/create', subscriptionId: 'gid://t2', uri: move.toUri },
      { kind: 'delete', topic: 'orders/create', subscriptionId: 'gid://s1', uri: move.fromUri },
    ]);
  });

  it('creates when neither address has one, and never touches other uris (other apps, other workspaces, other topics)', () => {
    const foreign = [
      sub('gid://f1', 'orders/create', 'https://other-app.example.com/hook'),
      sub(
        'gid://f2',
        'orders/create',
        `${OLD}/api/v1/workspaces/${WS_B}/integrations/shopify/webhooks`,
      ),
      sub('gid://f3', 'customers/create', move.fromUri),
    ];
    expect(planWebhookSubscriptionMigration(foreign, [move])).toEqual([
      { kind: 'create', topic: 'orders/create', toUri: move.toUri },
    ]);
  });
});

describe('ShopifyWebhookMigrationService', () => {
  it('dry run (default) plans without a single Shopify mutation', async () => {
    const shop = new FakeShop(managed(OLD, WS_A));
    const { service } = makeService({ backendUrl: NEW, shops: { [WS_A]: shop } });

    const report = await service.migrate({
      fromBackendUrl: OLD,
      apply: false,
      allWorkspaces: true,
    });

    expect(shop.mutations).toBe(0);
    expect(report.applied).toBe(false);
    expect(
      report.workspaces[0].actions.every((a) => a.kind === 'update' && a.status === 'planned'),
    ).toBe(true);
    expect(report.workspaces[0].actions).toHaveLength(TOPIC_COUNT);
  });

  it('moves every managed subscription in place — same ids, configuration re-sent, verified — and a re-run changes nothing', async () => {
    const subs = managed(OLD, WS_A);
    subs[0].includeFields = ['id', 'email'];
    subs[0].filter = 'id:*';
    const idsBefore = subs.map((s) => s.id).sort();
    const shop = new FakeShop(subs);
    const { service } = makeService({ backendUrl: NEW, shops: { [WS_A]: shop } });

    const report = await service.migrate({ fromBackendUrl: OLD, apply: true, allWorkspaces: true });

    expect(report.ok).toBe(true);
    expect(report.workspaces[0].verified).toBe(true);
    expect(shop.subs.map((s) => s.id).sort()).toEqual(idsBefore); // identity preserved, nothing created or deleted
    expect(new Set(shop.subs.map((s) => s.uri))).toEqual(managedUris(NEW, WS_A));
    expect(shop.updates[0].input).toEqual({
      uri: expect.stringContaining(NEW),
      filter: 'id:*',
      format: 'JSON',
      includeFields: ['id', 'email'],
      metafieldNamespaces: [],
      name: null,
    });

    const mutationsAfterFirst = shop.mutations;
    const again = await service.migrate({ fromBackendUrl: OLD, apply: true, allWorkspaces: true });
    expect(shop.mutations).toBe(mutationsAfterFirst); // idempotent: only `keep`
    expect(again.workspaces[0].actions.every((a) => a.kind === 'keep')).toBe(true);
    expect(again.ok).toBe(true);
  });

  it('rollback is the same call on the other backend: subscriptions return to the old uri on the same ids', async () => {
    const shop = new FakeShop(managed(OLD, WS_A));
    const ids = shop.subs.map((s) => s.id).sort();
    await makeService({ backendUrl: NEW, shops: { [WS_A]: shop } }).service.migrate({
      fromBackendUrl: OLD,
      apply: true,
      allWorkspaces: true,
    });

    const back = await makeService({ backendUrl: OLD, shops: { [WS_A]: shop } }).service.migrate({
      fromBackendUrl: NEW,
      apply: true,
      allWorkspaces: true,
    });

    expect(back.ok).toBe(true);
    expect(new Set(shop.subs.map((s) => s.uri))).toEqual(managedUris(OLD, WS_A));
    expect(shop.subs.map((s) => s.id).sort()).toEqual(ids);
  });

  it('removes a duplicate left by an earlier reconnect, ending with exactly one subscription per topic', async () => {
    const shop = new FakeShop([
      ...managed(OLD, WS_A),
      sub(
        'gid://dup',
        'orders/create',
        `${NEW}/api/v1/workspaces/${WS_A}/integrations/shopify/webhooks`,
      ),
    ]);
    const { service } = makeService({ backendUrl: NEW, shops: { [WS_A]: shop } });

    const report = await service.migrate({ fromBackendUrl: OLD, apply: true, allWorkspaces: true });

    expect(report.ok).toBe(true);
    const ordersCreate = shop.subs.filter((s) => s.topic === 'ORDERS_CREATE');
    expect(ordersCreate).toHaveLength(1);
    expect(ordersCreate[0].id).toBe('gid://dup');
    expect(shop.subs).toHaveLength(TOPIC_COUNT);
  });

  it('a partial failure keeps the failed topic on its source (no deletion), reports not-ok, and a re-run completes it', async () => {
    const shop = new FakeShop(managed(OLD, WS_A));
    shop.failUpdateFor.add('ORDERS_CREATE');
    const { service } = makeService({ backendUrl: NEW, shops: { [WS_A]: shop } });

    const report = await service.migrate({ fromBackendUrl: OLD, apply: true, allWorkspaces: true });

    expect(report.ok).toBe(false);
    expect(report.workspaces[0].verified).toBe(false);
    const failed = report.workspaces[0].actions.filter((a) => a.status === 'failed');
    expect(failed).toEqual([
      expect.objectContaining({
        topic: 'orders/create',
        kind: 'update',
        error: expect.stringContaining('throttled'),
      }),
    ]);
    expect(shop.subs.find((s) => s.topic === 'ORDERS_CREATE')!.uri.startsWith(OLD)).toBe(true); // still delivering
    expect(shop.subs.filter((s) => s.uri.startsWith(NEW))).toHaveLength(TOPIC_COUNT - 1);

    shop.failUpdateFor.clear();
    const retry = await service.migrate({ fromBackendUrl: OLD, apply: true, allWorkspaces: true });
    expect(retry.ok).toBe(true);
    expect(new Set(shop.subs.map((s) => s.uri))).toEqual(managedUris(NEW, WS_A));
  });

  it("isolates stores: one store's failure doesn't stop another's migration, and only managed uris of each workspace move", async () => {
    const shopB = new FakeShop([
      ...managed(OLD, WS_B),
      sub('gid://foreign', 'orders/create', 'https://other-app.example.com/hook'),
    ]);
    const { service } = makeService({
      backendUrl: NEW,
      shops: { [WS_A]: new Error('decrypt failed'), [WS_B]: shopB },
    });

    const report = await service.migrate({ fromBackendUrl: OLD, apply: true, allWorkspaces: true });

    expect(report.ok).toBe(false);
    expect(report.workspaces.find((w) => w.workspaceId === WS_A)!.error).toBe('decrypt failed');
    expect(report.workspaces.find((w) => w.workspaceId === WS_B)!.verified).toBe(true);
    expect(shopB.subs.find((s) => s.id === 'gid://foreign')!.uri).toBe(
      'https://other-app.example.com/hook',
    );
  });

  it('never deletes a copy whose configuration differs (e.g. a filtered subscription): it is reported for review and the run is not ok', async () => {
    const target = `${NEW}/api/v1/workspaces/${WS_A}/integrations/shopify/webhooks`;
    const shop = new FakeShop([
      ...managed(OLD, WS_A),
      sub('gid://filtered', 'orders/create', target, { filter: 'total_price:>100' }),
    ]);
    const { service } = makeService({ backendUrl: NEW, shops: { [WS_A]: shop } });

    const report = await service.migrate({ fromBackendUrl: OLD, apply: true, allWorkspaces: true });

    expect(report.ok).toBe(false);
    expect(report.workspaces[0].verified).toBe(false);
    expect(shop.subs.find((s) => s.id === 'gid://filtered')).toBeDefined(); // the filtered one survives
    expect(report.workspaces[0].actions).toContainEqual(
      expect.objectContaining({
        topic: 'orders/create',
        kind: 'review',
        status: 'skipped',
        error: expect.stringContaining('manual review'),
      }),
    );
  });

  it('requires an explicit scope: exactly one of workspaceId or allWorkspaces', async () => {
    const { service } = makeService({ backendUrl: NEW, shops: {} });
    await expect(service.migrate({ fromBackendUrl: OLD, apply: false })).rejects.toThrow(
      'exactly one of workspaceId or allWorkspaces',
    );
    await expect(
      service.migrate({
        fromBackendUrl: OLD,
        apply: false,
        workspaceId: WS_A,
        allWorkspaces: true,
      }),
    ).rejects.toThrow('exactly one of workspaceId or allWorkspaces');
  });

  it('apply runs only under the shared advisory lock; a concurrent apply gets a conflict and changes nothing (dry run takes no lock)', async () => {
    const shop = new FakeShop(managed(OLD, WS_A));
    const busy = makeService({ backendUrl: NEW, shops: { [WS_A]: shop }, lockFree: false });
    await expect(
      busy.service.migrate({ fromBackendUrl: OLD, apply: true, allWorkspaces: true }),
    ).rejects.toThrow('Another Shopify webhook subscription migration is running');
    expect(shop.mutations).toBe(0);
    expect(busy.lockQueries).toHaveLength(1);

    const dry = makeService({ backendUrl: NEW, shops: { [WS_A]: shop }, lockFree: false });
    await dry.service.migrate({ fromBackendUrl: OLD, apply: false, allWorkspaces: true });
    expect(dry.lockQueries).toHaveLength(0);
  });

  it('refuses to "migrate" onto itself', async () => {
    const { service } = makeService({ backendUrl: NEW, shops: {} });
    await expect(
      service.migrate({ fromBackendUrl: `${NEW}/`, apply: true, allWorkspaces: true }),
    ).rejects.toThrow('fromBackendUrl is this backend');
  });
});
