import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { integrations } from '../../database/schema/integrations';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { EventBus } from '../../common/events/event-bus.service';
import { CustomerService } from '../commerce/customer.service';
import { IntegrationService } from './integration.service';
import { WebhookIngestService } from './webhook-ingest.service';
import { WebhookEventProcessorService, WEBHOOK_MAX_ATTEMPTS } from './webhook-event-processor.service';

/**
 * Durable webhook processing against the real dev DB (same approach as
 * full-loop.spec.ts). Claiming, SKIP LOCKED, lease reclaim and fencing are
 * Postgres behavior, so they're proven here rather than with mocks.
 *
 * Timing is driven through the database, not sleeps: a crash is a claim
 * that's never finished, lease expiry / backoff elapse are simulated by
 * moving `locked_until` / `next_attempt_at` into the past. Concurrency and
 * fencing cases only ever claim this spec's own rows by id, and the poller
 * sweeps (`processDue`) are scoped to this spec's workspace, so they can't
 * claim or strand rows another spec file (running in parallel) is waiting on.
 */
// Every step is a real Neon round trip (~250ms each), so the default 5s per-test budget is too tight.
describe('Durable webhook processing (real DB)', { timeout: 30_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let ingest: WebhookIngestService;
  let processor: WebhookEventProcessorService;
  let eventBus: EventBus;

  const workspaceId = randomUUID();
  const webhookSecret = 'durability-test-secret';
  let integrationId: string;

  async function bootModule(): Promise<TestingModule> {
    const ref = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await ref.init(); // registers ShopifyAdapter into ProviderRegistry
    return ref;
  }

  function useModule(ref: TestingModule) {
    moduleRef = ref;
    db = ref.get(DatabaseService);
    ingest = ref.get(WebhookIngestService);
    processor = ref.get(WebhookEventProcessorService);
    eventBus = ref.get(EventBus);
  }

  /** A signed Shopify customers/create delivery with a unique delivery id. */
  function delivery(externalCustomerId = String(1 + Math.floor(Math.random() * 1e12))) {
    const body = JSON.stringify({
      id: Number(externalCustomerId),
      email: null,
      first_name: 'Dura',
      last_name: 'Ble',
      phone: null,
      updated_at: '2026-01-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
    });
    const headers = {
      'x-shopify-topic': 'customers/create',
      'x-shopify-hmac-sha256': createHmac('sha256', webhookSecret).update(body, 'utf8').digest('base64'),
      'x-shopify-webhook-id': randomUUID(),
    };
    return { body, headers, externalCustomerId };
  }

  /** Ingest with the wake-up suppressed — the state a crash right after the HTTP 200 leaves behind. */
  async function ingestWithoutWake(d = delivery()) {
    const emit = vi.spyOn(eventBus, 'emit').mockImplementationOnce(() => undefined);
    const result = await ingest.ingest(workspaceId, 'shopify', d.body, d.headers);
    emit.mockRestore();
    if (result.status !== 'accepted') throw new Error(`expected accepted, got ${result.status}`);
    return { ...d, webhookEventId: result.webhookEventId };
  }

  async function row(id: string) {
    const [r] = await db.client.select().from(integrationWebhookEvents).where(eq(integrationWebhookEvents.id, id));
    return r;
  }

  async function customerRows(externalId: string) {
    return db.client
      .select({ id: commerceCustomers.id })
      .from(commerceCustomers)
      .where(sql`${commerceCustomers.workspaceId} = ${workspaceId} and ${commerceCustomers.externalId} = ${externalId}`);
  }

  async function backdate(id: string, column: 'locked_until' | 'next_attempt_at') {
    await db.client.execute(sql`update integration_webhook_events set ${sql.raw(column)} = now() - interval '1 second' where id = ${id}`);
  }

  /** Polls the row (DB synchronization, not a fixed sleep) until it reaches `status`. */
  async function waitForStatus(id: string, status: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await row(id);
      if (r?.status === status) return r;
      if (Date.now() > deadline) throw new Error(`row ${id} stayed ${r?.status}, expected ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    useModule(await bootModule());
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    await db.client.insert(workspaces).values({ id: workspaceId, name: 'Webhook Durability Test Workspace' });
    const integrationService = moduleRef.get(IntegrationService);
    integrationId = (await integrationService.connect(workspaceId, 'shopify')).id;
    await integrationService.setCredentials(workspaceId, 'shopify', {
      shopDomain: 'brayn-durability-test.myshopify.com',
      accessToken: 'unused-in-this-test',
      webhookSecret,
    });
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

  it('persists the delivery as a pending row before acknowledging, then the wake-up processes it', async () => {
    const d = delivery();
    const emit = vi.spyOn(eventBus, 'emit');

    const result = await ingest.ingest(workspaceId, 'shopify', d.body, d.headers);

    expect(result.status).toBe('accepted');
    const webhookEventId = (result as { webhookEventId: string }).webhookEventId;
    // The row exists, committed, the moment ingest() returned — before any handler result.
    expect(await row(webhookEventId)).toBeDefined();
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ payload: { webhookEventId } }));
    emit.mockRestore();

    const processed = await waitForStatus(webhookEventId, 'processed');
    expect(processed.claimToken).toBeNull();
    expect(processed.processedAt).not.toBeNull();
    expect(await customerRows(d.externalCustomerId)).toHaveLength(1);
  });

  it('does not lose the event when the wake-up emit throws: the row stays pending and the recovery sweep processes it', async () => {
    const d = delivery();
    const emit = vi.spyOn(eventBus, 'emit').mockImplementationOnce(() => {
      throw new Error('event bus down');
    });

    const result = await ingest.ingest(workspaceId, 'shopify', d.body, d.headers);
    emit.mockRestore();

    expect(result.status).toBe('accepted');
    const webhookEventId = (result as { webhookEventId: string }).webhookEventId;
    expect((await row(webhookEventId)).status).toBe('pending');

    await processor.processDue(undefined, { workspaceId });

    expect((await row(webhookEventId)).status).toBe('processed');
    expect(await customerRows(d.externalCustomerId)).toHaveLength(1);
  });

  it('makes a failed attempt retryable with backoff, and a later attempt processes it', async () => {
    const { webhookEventId, externalCustomerId } = await ingestWithoutWake();
    const upsert = vi.spyOn(moduleRef.get(CustomerService), 'upsertMany').mockRejectedValue(new Error('downstream unavailable'));

    expect(await processor.processEvent(webhookEventId)).toBe(true);
    upsert.mockRestore();

    const failed = await row(webhookEventId);
    expect(failed.status).toBe('pending');
    expect(failed.retryCount).toBe(1);
    expect(failed.error).toBe('downstream unavailable');
    expect(failed.claimToken).toBeNull();
    expect(failed.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    // Not due yet — no tight retry loop.
    expect(await processor.processEvent(webhookEventId)).toBe(false);

    await backdate(webhookEventId, 'next_attempt_at');
    expect(await processor.processEvent(webhookEventId)).toBe(true);

    const done = await row(webhookEventId);
    expect(done.status).toBe('processed');
    expect(done.retryCount).toBe(2);
    expect(done.error).toBeNull();
    expect(await customerRows(externalCustomerId)).toHaveLength(1);
  });

  it('leaves a worker crash mid-processing recoverable: the abandoned claim is reclaimed once its lease expires', async () => {
    const { webhookEventId } = await ingestWithoutWake();

    const [crashed] = await processor.claim({ webhookEventId }); // a worker claims, then "crashes"
    expect(crashed).toBeDefined();
    expect((await row(webhookEventId)).status).toBe('processing');

    // Lease still live: nobody may take it.
    expect(await processor.processEvent(webhookEventId)).toBe(false);

    await backdate(webhookEventId, 'locked_until');
    expect(await processor.processEvent(webhookEventId)).toBe(true);

    const recovered = await row(webhookEventId);
    expect(recovered.status).toBe('processed');
    expect(recovered.retryCount).toBe(2);
  });

  it('lets exactly one of many concurrent workers claim the same event', async () => {
    const { webhookEventId } = await ingestWithoutWake();

    const results = await Promise.all(Array.from({ length: 10 }, () => processor.claim({ webhookEventId })));

    const winners = results.filter((claims) => claims.length === 1);
    expect(winners).toHaveLength(1);
    expect((await row(webhookEventId)).claimToken).toBe(winners[0][0].claimToken);
  });

  it('fences a stale worker: finishing after its claim was reclaimed records nothing and cannot mark the newer attempt done', async () => {
    const { webhookEventId } = await ingestWithoutWake();

    const [stale] = await processor.claim({ webhookEventId });
    await backdate(webhookEventId, 'locked_until');
    const [current] = await processor.claim({ webhookEventId });
    expect(current.claimToken).not.toBe(stale.claimToken);

    expect(await processor.complete(stale)).toBe(false);
    const stillOwned = await row(webhookEventId);
    expect(stillOwned.status).toBe('processing');
    expect(stillOwned.claimToken).toBe(current.claimToken);

    expect(await processor.complete(current)).toBe(true);
    expect((await row(webhookEventId)).status).toBe('processed');
  });

  it('keeps a redelivery idempotent while the first delivery is still pending (crash before processing): one row, one business record', async () => {
    const first = await ingestWithoutWake();

    const redelivery = await ingest.ingest(workspaceId, 'shopify', first.body, first.headers);
    expect(redelivery).toEqual({ status: 'duplicate' });

    const rows = await db.client
      .select({ id: integrationWebhookEvents.id })
      .from(integrationWebhookEvents)
      .where(sql`${integrationWebhookEvents.integrationId} = ${integrationId} and ${integrationWebhookEvents.externalEventId} = ${first.headers['x-shopify-webhook-id']}`);
    expect(rows).toHaveLength(1);

    await processor.processDue(undefined, { workspaceId });
    expect((await row(first.webhookEventId)).status).toBe('processed');
    expect(await customerRows(first.externalCustomerId)).toHaveLength(1);
  });

  it('keeps an already-processed delivery deduplicated without touching its row', async () => {
    const first = await ingestWithoutWake();
    await processor.processEvent(first.webhookEventId);
    const before = await row(first.webhookEventId);

    expect(await ingest.ingest(workspaceId, 'shopify', first.body, first.headers)).toEqual({ status: 'duplicate' });

    const after = await row(first.webhookEventId);
    expect(after.status).toBe('processed');
    expect(after.retryCount).toBe(before.retryCount);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('never leaves a failing event stuck: exhausted attempts dead-letter it, and replay requeues it for processing', async () => {
    const { webhookEventId, externalCustomerId } = await ingestWithoutWake();
    await db.client.update(integrationWebhookEvents).set({ retryCount: WEBHOOK_MAX_ATTEMPTS - 1 }).where(eq(integrationWebhookEvents.id, webhookEventId));
    const upsert = vi.spyOn(moduleRef.get(CustomerService), 'upsertMany').mockRejectedValue(new Error('still broken'));

    await processor.processEvent(webhookEventId);
    upsert.mockRestore();

    const dead = await row(webhookEventId);
    expect(dead.status).toBe('dead_letter');
    expect(dead.retryCount).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(dead.claimToken).toBeNull();

    expect(await ingest.replay(workspaceId, webhookEventId)).toEqual({ status: 'accepted' });
    const processed = await waitForStatus(webhookEventId, 'processed');
    expect(processed.retryCount).toBe(1);
    expect(await customerRows(externalCustomerId)).toHaveLength(1);
  });

  it('recovers pending events after an application restart (fresh module, no wake-up)', async () => {
    const { webhookEventId, externalCustomerId } = await ingestWithoutWake();

    await moduleRef.close(); // the "crash": the process that acknowledged the delivery is gone
    useModule(await bootModule());

    expect((await row(webhookEventId)).status).toBe('pending');
    await processor.processDue(undefined, { workspaceId });

    expect((await row(webhookEventId)).status).toBe('processed');
    expect(await customerRows(externalCustomerId)).toHaveLength(1);
  }, 30_000);
});
