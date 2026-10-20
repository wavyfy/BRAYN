import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { WebhookEventProcessorService, WEBHOOK_MAX_ATTEMPTS, type ClaimedWebhookEvent } from './webhook-event-processor.service';
import { createEvent } from '../../common/events/domain-event';
import type { DatabaseService } from '../../database/database.service';
import type { CustomerService } from '../commerce/customer.service';
import type { ProductService } from '../commerce/product.service';
import type { OrderService } from '../commerce/order.service';
import type { CollectionService } from '../commerce/collection.service';
import type { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import type { StructuredLoggerService } from '../../common/logging/structured-logger.service';

/**
 * Routing and outcome logic with `claim()` stubbed. Real claiming,
 * SKIP LOCKED concurrency, lease reclaim, and token fencing against
 * Postgres are proven in webhook-durability.db.spec.ts.
 */
function makeChain(finalResult: unknown) {
  const chain: Record<string, unknown> = {
    set: vi.fn(() => chain),
    where: vi.fn(() => chain),
    returning: vi.fn(async () => finalResult),
  };
  return chain;
}

function makeProcessor(options: { finishResult?: unknown[] } = {}) {
  const updateChain = makeChain(options.finishResult ?? [{ id: 'wh_1' }]);
  const client = { update: vi.fn(() => updateChain) };
  const database = { client } as unknown as DatabaseService;
  const customerService = { upsertMany: vi.fn(async () => 1) } as unknown as CustomerService;
  const productService = { upsertMany: vi.fn(async () => ({ productsWritten: 1, variantsWritten: 0 })) } as unknown as ProductService;
  const orderService = {
    upsertMany: vi.fn(async () => ({ ordersWritten: 1, lineItemsWritten: 0, refundsWritten: 0, fulfillmentsWritten: 0, newOrderCanonicalCustomerIds: [] })),
    upsertFulfillments: vi.fn(async () => 1),
  } as unknown as OrderService;
  const collectionService = { upsertMany: vi.fn(async () => 1) } as unknown as CollectionService;
  const identityResolutionService = { resolveMany: vi.fn(async () => undefined) } as unknown as IdentityResolutionService;
  const logger = { event: vi.fn() } as unknown as StructuredLoggerService;

  const processor = new WebhookEventProcessorService(
    database,
    customerService,
    productService,
    orderService,
    collectionService,
    identityResolutionService,
    logger,
  );

  return { processor, client, updateChain, customerService, productService, orderService, collectionService, identityResolutionService, logger };
}

function claimed(payload: unknown, overrides: Partial<ClaimedWebhookEvent> = {}): ClaimedWebhookEvent {
  return {
    id: 'wh_1',
    workspaceId: 'ws_1',
    integrationId: 'int_1',
    provider: 'shopify',
    payload,
    claimToken: 'token_1',
    attempt: 1,
    ...overrides,
  };
}

/** Stubs the DB claim so processEvent() runs exactly this claimed row. */
function stubClaim(processor: WebhookEventProcessorService, row: ClaimedWebhookEvent | null) {
  return vi.spyOn(processor, 'claim').mockResolvedValue(row ? [row] : []);
}

const lastSet = (updateChain: Record<string, unknown>) =>
  (updateChain.set as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as Record<string, unknown>;

const customer = { externalId: '1', email: 'a@x.com', firstName: 'Ada', lastName: 'L', phone: null, sourceUpdatedAt: new Date(), sourceCreatedAt: null };

describe('WebhookEventProcessorService', () => {
  describe('resource routing', () => {
    it('applies a customer resource event, resolves identity, and marks the row processed under its claim token', async () => {
      const { processor, customerService, productService, orderService, identityResolutionService, updateChain } = makeProcessor();
      stubClaim(processor, claimed({ resource: 'customer', data: customer }));

      expect(await processor.processEvent('wh_1')).toBe(true);

      expect(customerService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', [customer]);
      expect(identityResolutionService.resolveMany).toHaveBeenCalledWith('ws_1', 'shopify', ['1']);
      expect(productService.upsertMany).not.toHaveBeenCalled();
      expect(orderService.upsertMany).not.toHaveBeenCalled();
      expect(lastSet(updateChain)).toMatchObject({ status: 'processed', error: null, claimToken: null, lockedUntil: null });
      const where = new PgDialect().sqlToQuery((updateChain.where as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as SQL);
      expect(where.params).toEqual(['wh_1', 'processing', 'token_1']);
    });

    it('restores the jsonb-stored ISO timestamps to Dates before upserting (stored payloads come back as strings)', async () => {
      const { processor, customerService } = makeProcessor();
      stubClaim(processor, claimed(JSON.parse(JSON.stringify({ resource: 'customer', data: { ...customer, sourceUpdatedAt: new Date('2026-01-02T03:04:05.000Z') } }))));

      await processor.processEvent('wh_1');

      const [, , , [written]] = vi.mocked(customerService.upsertMany).mock.calls[0];
      expect(written.sourceUpdatedAt).toEqual(new Date('2026-01-02T03:04:05.000Z'));
      expect(written.email).toBe('a@x.com');
    });

    it('applies a product resource event via ProductService.upsertMany', async () => {
      const { processor, productService } = makeProcessor();
      const product = { externalId: '55', title: 'Tee', sourceUpdatedAt: new Date(), variants: [] };
      stubClaim(processor, claimed({ resource: 'product', data: product }));

      await processor.processEvent('wh_1');

      expect(productService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', [product]);
    });

    it('applies an order resource event as a live change, leaving domain-event emission to the commerce domain', async () => {
      const { processor, orderService } = makeProcessor();
      const order = { externalId: '900', customerExternalId: null, totalPrice: '19.99', sourceUpdatedAt: new Date(), lineItems: [] };
      stubClaim(processor, claimed({ resource: 'order', data: order }));

      await processor.processEvent('wh_1');

      expect(orderService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', [order], { emitDomainEvents: true });
    });

    it('applies a fulfillment resource event via OrderService.upsertFulfillments', async () => {
      const { processor, orderService } = makeProcessor();
      const fulfillment = { externalId: '7001', orderExternalId: '900', status: 'success', sourceUpdatedAt: new Date() };
      stubClaim(processor, claimed({ resource: 'fulfillment', data: fulfillment }));

      await processor.processEvent('wh_1');

      expect(orderService.upsertFulfillments).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', [fulfillment]);
    });

    it('applies a collection resource event via CollectionService.upsertMany', async () => {
      const { processor, collectionService } = makeProcessor();
      const collection = { externalId: '10', title: 'Summer Sale', sourceUpdatedAt: new Date() };
      stubClaim(processor, claimed({ resource: 'collection', data: collection }));

      await processor.processEvent('wh_1');

      expect(collectionService.upsertMany).toHaveBeenCalledWith('ws_1', 'int_1', 'shopify', [collection]);
    });
  });

  describe('outcomes', () => {
    it('does nothing when the row is not claimable (already claimed, processed, or not yet due)', async () => {
      const { processor, customerService, client } = makeProcessor();
      stubClaim(processor, null);

      expect(await processor.processEvent('wh_1')).toBe(false);
      expect(customerService.upsertMany).not.toHaveBeenCalled();
      expect(client.update).not.toHaveBeenCalled();
    });

    it('retries a transient failure in-process and marks the row processed once it succeeds', async () => {
      const { processor, customerService, updateChain } = makeProcessor();
      vi.mocked(customerService.upsertMany).mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce(1);
      stubClaim(processor, claimed({ resource: 'customer', data: customer }));

      await processor.processEvent('wh_1');

      expect(customerService.upsertMany).toHaveBeenCalledTimes(2);
      expect(lastSet(updateChain)).toMatchObject({ status: 'processed' });
    });

    it('reschedules a failed attempt back to pending with backoff (not dead_letter) while attempts remain, and logs ids + attempt', async () => {
      const { processor, customerService, updateChain, logger } = makeProcessor();
      vi.mocked(customerService.upsertMany).mockRejectedValue(new Error('db down'));
      stubClaim(processor, claimed({ resource: 'customer', data: customer }, { attempt: 2 }));

      await expect(processor.processEvent('wh_1')).resolves.toBe(true);

      const set = lastSet(updateChain);
      expect(set).toMatchObject({ status: 'pending', error: 'db down', claimToken: null, lockedUntil: null });
      const backoff = new PgDialect().sqlToQuery(set.nextAttemptAt as SQL);
      expect(backoff.sql).toContain('now() +');
      expect(backoff.params).toEqual([60_000]);
      expect(logger.event).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('rescheduled'),
        'WebhookEventProcessorService',
        expect.objectContaining({ webhookEventId: 'wh_1', integrationId: 'int_1', workspaceId: 'ws_1', attempt: 2, error: 'db down' }),
      );
    });

    it('dead-letters once the final attempt fails', async () => {
      const { processor, customerService, updateChain } = makeProcessor();
      vi.mocked(customerService.upsertMany).mockRejectedValue(new Error('db down'));
      stubClaim(processor, claimed({ resource: 'customer', data: customer }, { attempt: WEBHOOK_MAX_ATTEMPTS }));

      await processor.processEvent('wh_1');

      expect(lastSet(updateChain)).toMatchObject({ status: 'dead_letter', error: 'db down' });
    });

    it('dead-letters without reprocessing a row reclaimed past its attempt budget (crashed/hung on every attempt)', async () => {
      const { processor, customerService, updateChain } = makeProcessor();
      stubClaim(processor, claimed({ resource: 'customer', data: customer }, { attempt: WEBHOOK_MAX_ATTEMPTS + 1 }));

      await processor.processEvent('wh_1');

      expect(customerService.upsertMany).not.toHaveBeenCalled();
      expect(lastSet(updateChain)).toMatchObject({ status: 'dead_letter' });
    });

    it('dead-letters immediately (no retries) when the stored payload is not a recognized resource event', async () => {
      const { processor, customerService, updateChain } = makeProcessor();
      stubClaim(processor, claimed({ foo: 'bar' }));

      await processor.processEvent('wh_1');

      expect(customerService.upsertMany).not.toHaveBeenCalled();
      expect(lastSet(updateChain)).toMatchObject({ status: 'dead_letter' });
    });

    it('logs (and records nothing) when its claim was taken over before it finished', async () => {
      const { processor, logger } = makeProcessor({ finishResult: [] });
      stubClaim(processor, claimed({ resource: 'customer', data: customer }));

      await processor.processEvent('wh_1');

      expect(logger.event).toHaveBeenCalledWith('warn', expect.stringContaining('taken over'), 'WebhookEventProcessorService', expect.objectContaining({ webhookEventId: 'wh_1' }));
    });

    it('scrubs sensitive text out of the persisted error column', async () => {
      const { processor, customerService, updateChain } = makeProcessor();
      vi.mocked(customerService.upsertMany).mockRejectedValue(new Error('upstream call for jane@example.com failed using Bearer sometoken1234567890'));
      stubClaim(processor, claimed({ resource: 'customer', data: customer }));

      await processor.processEvent('wh_1');

      expect(lastSet(updateChain).error).toBe('upstream call for [redacted-email] failed using Bearer [redacted-token]');
    });
  });

  describe('wake-up handler', () => {
    it('claims the named row', async () => {
      const { processor } = makeProcessor();
      const spy = stubClaim(processor, null);

      await processor.handleWebhookReceived(createEvent({ type: 'integration.webhook.received', workspaceId: 'ws_1', entityId: 'int_1', payload: { webhookEventId: 'wh_1' } }));

      expect(spy).toHaveBeenCalledWith({ webhookEventId: 'wh_1' });
    });

    it('never rethrows — a failed wake-up leaves the row for the recovery poller', async () => {
      const { processor, logger } = makeProcessor();
      vi.spyOn(processor, 'claim').mockRejectedValue(new Error('db unreachable'));

      await expect(
        processor.handleWebhookReceived(createEvent({ type: 'integration.webhook.received', workspaceId: 'ws_1', entityId: 'int_1', payload: { webhookEventId: 'wh_1' } })),
      ).resolves.toBeUndefined();
      expect(logger.event).toHaveBeenCalledWith('error', expect.any(String), 'WebhookEventProcessorService', expect.objectContaining({ webhookEventId: 'wh_1' }));
    });
  });
});
