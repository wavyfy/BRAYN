import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ShopifyComplianceService } from './shopify-compliance.service';
import { customerDataRequests } from '../../../../database/schema/customer-data-requests';
import { ConflictError } from '../../../../common/errors/app-error';
import type { DatabaseService } from '../../../../database/database.service';
import type { IntegrationService } from '../../integration.service';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../../config/env.schema';
import type { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';

const CLIENT_SECRET = 'shpss_test_secret';

function sign(rawBody: string, secret = CLIENT_SECRET): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

/** `null` (not `undefined`, which TS default params would silently replace with CLIENT_SECRET) simulates an unconfigured secret. */
function makeConfig(secret: string | null = CLIENT_SECRET): ConfigService<Env, true> {
  return { get: () => secret ?? undefined } as unknown as ConfigService<Env, true>;
}

function makeLogger(): StructuredLoggerService {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

/**
 * `claim` = what the shopify_compliance_webhooks claim upsert returns: a row (this attempt owns the delivery) or none,
 * in which case `existingStatus` is the status of the already-recorded delivery. Real-DB behaviour of the claim is
 * covered in store-ownership.db.spec.
 */
function makeDatabase(opts: { claimed?: boolean; existingStatus?: string } = {}) {
  const claimed = opts.claimed ?? true;
  const values = vi.fn((rows: unknown) => ({
    rows,
    onConflictDoUpdate: () => ({ returning: async () => (claimed ? [{ attempt: 1 }] : []) }),
    then: (resolve: (value: unknown) => unknown) => resolve(undefined),
  }));
  const insert = vi.fn(() => ({ values }));
  const where = vi.fn(() => ({
    returning: async () => [{ id: 'row_1' }],
    then: (resolve: (value: unknown) => unknown) => resolve(undefined),
  }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ limit: async () => [{ status: opts.existingStatus ?? 'processed' }] }) }),
  }));
  const client = { insert, update, select };
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(client));
  return { database: { client, transaction } as unknown as DatabaseService, insert, values, set };
}

describe('ShopifyComplianceService', () => {
  it('rejects a request with a missing/invalid signature', async () => {
    const { database } = makeDatabase();
    const integrationService = { resolveShopHolders: vi.fn() } as unknown as IntegrationService;
    const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

    const rawBody = JSON.stringify({ shop_domain: 'wavyfyy.myshopify.com' });

    await expect(service.handle('shop/redact', rawBody, { 'x-shopify-hmac-sha256': 'not-the-right-signature' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('fails closed when SHOPIFY_APP_CLIENT_SECRET is not configured', async () => {
    const { database } = makeDatabase();
    const integrationService = { resolveShopHolders: vi.fn() } as unknown as IntegrationService;
    const service = new ShopifyComplianceService(makeConfig(null), database, integrationService, makeLogger());

    const rawBody = JSON.stringify({ shop_domain: 'wavyfyy.myshopify.com' });

    await expect(service.handle('shop/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) })).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
  });

  describe('customers/data_request', () => {
    it('persists the request with the resolved workspace/integration when the shop is known', async () => {
      const { database, insert, values } = makeDatabase();
      const integration = { id: 'int_1', workspaceId: 'ws_1' };
      const integrationService = { resolveShopHolders: vi.fn(async () => ({ holders: [integration], conflicts: [] })),
        recordShopifyShopId: vi.fn(async () => 'ok') } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({
        shop_domain: 'wavyfyy.myshopify.com',
        customer: { id: 191167, email: 'jane@example.com' },
        orders_requested: [1, 2, 3],
      });

      await service.handle('customers/data_request', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) });

      expect(integrationService.resolveShopHolders).toHaveBeenCalledWith('wavyfyy.myshopify.com', undefined);
      expect(insert).toHaveBeenCalledWith(customerDataRequests);
      expect(values).toHaveBeenCalledWith([
        {
          workspaceId: 'ws_1',
          integrationId: 'int_1',
          provider: 'shopify',
          shopDomain: 'wavyfyy.myshopify.com',
          shopifyCustomerId: '191167',
          customerEmail: 'jane@example.com',
          ordersRequested: [1, 2, 3],
        },
      ]);
    });

    it('records the request once per workspace holding the store (never one picked by recency)', async () => {
      const { database, values } = makeDatabase();
      const integrationService = {
        resolveShopHolders: vi.fn(async () => ({ holders: [
          { id: 'int_old', workspaceId: 'ws_old', status: 'disconnected' },
          { id: 'int_live', workspaceId: 'ws_live', status: 'connected' },
        ], conflicts: [] })),
        recordShopifyShopId: vi.fn(async () => 'ok'),
      } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({ shop_domain: 'wavyfyy.myshopify.com', customer: { id: 7 } });
      await service.handle('customers/data_request', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) });

      expect(values).toHaveBeenCalledWith([
        expect.objectContaining({ workspaceId: 'ws_old', integrationId: 'int_old' }),
        expect.objectContaining({ workspaceId: 'ws_live', integrationId: 'int_live' }),
      ]);
    });

    it('persists the request with null workspace/integration when the shop is unrecognized, and still acknowledges', async () => {
      const { database, values } = makeDatabase();
      const integrationService = { resolveShopHolders: vi.fn(async () => ({ holders: [], conflicts: [] })),
        recordShopifyShopId: vi.fn(async () => 'ok') } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({ shop_domain: 'unknown.myshopify.com', customer: { id: 1 } });

      await expect(service.handle('customers/data_request', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) })).resolves.toBeUndefined();

      expect(values).toHaveBeenCalledWith([expect.objectContaining({ workspaceId: null, integrationId: null })]);
    });

    it('never logs the customer email or id — only shopDomain and a resolved flag', async () => {
      const { database } = makeDatabase();
      const integration = { id: 'int_1', workspaceId: 'ws_1' };
      const integrationService = { resolveShopHolders: vi.fn(async () => ({ holders: [integration], conflicts: [] })),
        recordShopifyShopId: vi.fn(async () => 'ok') } as unknown as IntegrationService;
      const logger = makeLogger();
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, logger);

      const rawBody = JSON.stringify({ shop_domain: 'wavyfyy.myshopify.com', customer: { id: 191167, email: 'jane@example.com' } });
      await service.handle('customers/data_request', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) });

      expect(logger.event).toHaveBeenCalledWith('log', expect.any(String), 'ShopifyComplianceService', {
        shopDomain: 'wavyfyy.myshopify.com',
        resolved: true,
        matchedIntegrations: 1,
      });
      expect(JSON.stringify((logger.event as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('jane@example.com');
      expect(JSON.stringify((logger.event as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('191167');
    });
  });

  describe('customers/redact', () => {
    it('erases the customer via IntegrationService.purgeCommerceCustomer when the shop is known', async () => {
      const { database } = makeDatabase();
      const integration = { id: 'int_1', workspaceId: 'ws_1' };
      const integrationService = {
        resolveShopHolders: vi.fn(async () => ({ holders: [integration], conflicts: [] })),
        recordShopifyShopId: vi.fn(async () => 'ok'),
        purgeCommerceCustomer: vi.fn(async () => ({ found: true, canonicalCustomerRemoved: true, ordersErased: 0 })),
      } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({ shop_domain: 'wavyfyy.myshopify.com', customer: { id: 191167, email: 'jane@example.com' } });
      await service.handle('customers/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) });

      expect(integrationService.purgeCommerceCustomer).toHaveBeenCalledWith('ws_1', 'int_1', '191167', []);
    });

    it('does nothing (but still acknowledges) when the shop is unrecognized', async () => {
      const { database } = makeDatabase();
      const integrationService = {
        resolveShopHolders: vi.fn(async () => ({ holders: [], conflicts: [] })),
        recordShopifyShopId: vi.fn(async () => 'ok'),
        purgeCommerceCustomer: vi.fn(),
      } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({ shop_domain: 'unknown.myshopify.com', customer: { id: 1 } });
      await expect(service.handle('customers/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) })).resolves.toBeUndefined();

      expect(integrationService.purgeCommerceCustomer).not.toHaveBeenCalled();
    });

    it('does nothing when the payload has no customer id', async () => {
      const { database } = makeDatabase();
      const integration = { id: 'int_1', workspaceId: 'ws_1' };
      const integrationService = {
        resolveShopHolders: vi.fn(async () => ({ holders: [integration], conflicts: [] })),
        recordShopifyShopId: vi.fn(async () => 'ok'),
        purgeCommerceCustomer: vi.fn(),
      } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({ shop_domain: 'wavyfyy.myshopify.com' });
      await service.handle('customers/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) });

      expect(integrationService.purgeCommerceCustomer).not.toHaveBeenCalled();
    });
  });

  describe('shop/redact', () => {
    it('erases the integration via IntegrationService.eraseIntegrationForShopRedact when the shop is known', async () => {
      const { database } = makeDatabase();
      const integration = { id: 'int_1', workspaceId: 'ws_1' };
      const integrationService = {
        resolveShopHolders: vi.fn(async () => ({ holders: [integration], conflicts: [] })),
        recordShopifyShopId: vi.fn(async () => 'ok'),
        eraseIntegrationForShopRedact: vi.fn(async () => ({ found: true })),
      } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({ shop_domain: 'wavyfyy.myshopify.com' });
      await service.handle('shop/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) });

      expect(integrationService.eraseIntegrationForShopRedact).toHaveBeenCalledWith('int_1');
    });

    it('erases every integration that holds the store, live or disconnected', async () => {
      const { database } = makeDatabase();
      const integrationService = {
        resolveShopHolders: vi.fn(async () => ({ holders: [
          { id: 'int_old', workspaceId: 'ws_old', status: 'disconnected' },
          { id: 'int_live', workspaceId: 'ws_live', status: 'connected' },
        ], conflicts: [] })),
        recordShopifyShopId: vi.fn(async () => 'ok'),
        eraseIntegrationForShopRedact: vi.fn(async () => ({ found: true })),
      } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({ shop_domain: 'wavyfyy.myshopify.com' });
      await service.handle('shop/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) });

      expect(integrationService.eraseIntegrationForShopRedact).toHaveBeenNthCalledWith(1, 'int_old');
      expect(integrationService.eraseIntegrationForShopRedact).toHaveBeenNthCalledWith(2, 'int_live');
    });

    it('does nothing (but still acknowledges) when the shop is unrecognized', async () => {
      const { database } = makeDatabase();
      const integrationService = {
        resolveShopHolders: vi.fn(async () => ({ holders: [], conflicts: [] })),
        recordShopifyShopId: vi.fn(async () => 'ok'),
        eraseIntegrationForShopRedact: vi.fn(),
      } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({ shop_domain: 'unknown.myshopify.com' });
      await expect(service.handle('shop/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) })).resolves.toBeUndefined();

      expect(integrationService.eraseIntegrationForShopRedact).not.toHaveBeenCalled();
    });
  });

  describe('retry contract (claim by X-Shopify-Webhook-Id)', () => {
    const shopKnown = () =>
      ({
        resolveShopHolders: vi.fn(async () => ({ holders: [{ id: 'int_1', workspaceId: 'ws_1', status: 'connected', shopifyShopId: null }], conflicts: [] })),
        recordShopifyShopId: vi.fn(async () => 'ok'),
        eraseIntegrationForShopRedact: vi.fn(async () => ({ found: true })),
        purgeCommerceCustomer: vi.fn(async () => ({ found: true, canonicalCustomerRemoved: false, ordersErased: 2 })),
      }) as unknown as IntegrationService;
    const deliver = (service: ShopifyComplianceService, topic: string, payload: object) => {
      const rawBody = JSON.stringify(payload);
      return service.handle(topic, rawBody, { 'x-shopify-hmac-sha256': sign(rawBody), 'x-shopify-webhook-id': 'wh_1' });
    };

    it('a redelivery of an already-processed webhook is acknowledged without doing the work again', async () => {
      const { database } = makeDatabase({ claimed: false, existingStatus: 'processed' });
      const integrationService = shopKnown();
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      await expect(deliver(service, 'shop/redact', { shop_domain: 'wavyfyy.myshopify.com' })).resolves.toBeUndefined();
      expect(integrationService.eraseIntegrationForShopRedact).not.toHaveBeenCalled();
    });

    it('a redelivery while an attempt is still running is answered 409 (Shopify retries later), with no work done', async () => {
      const { database } = makeDatabase({ claimed: false, existingStatus: 'processing' });
      const integrationService = shopKnown();
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      await expect(deliver(service, 'shop/redact', { shop_domain: 'wavyfyy.myshopify.com' })).rejects.toBeInstanceOf(ConflictError);
      expect(integrationService.eraseIntegrationForShopRedact).not.toHaveBeenCalled();
    });

    it('a failed erasure is recorded as failed (error category only) and rethrown, so Shopify redelivers', async () => {
      const { database, set } = makeDatabase();
      const integrationService = shopKnown();
      vi.mocked(integrationService.eraseIntegrationForShopRedact).mockRejectedValueOnce(
        Object.assign(new Error('deadlock detected on row jane@example.com'), { code: '40P01' }),
      );
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      await expect(deliver(service, 'shop/redact', { shop_domain: 'wavyfyy.myshopify.com' })).rejects.toThrow('deadlock');
      expect(set).toHaveBeenCalledWith({ status: 'failed', error: '40P01' });
    });

    it('customers/redact passes orders_to_redact through, so orders are erased even when the customer row is unknown', async () => {
      const { database } = makeDatabase();
      const integrationService = shopKnown();
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      await deliver(service, 'customers/redact', { shop_domain: 'wavyfyy.myshopify.com', orders_to_redact: [299938, 280263] });
      expect(integrationService.purgeCommerceCustomer).toHaveBeenCalledWith('ws_1', 'int_1', undefined, ['299938', '280263']);
    });
  });

  it('throws ValidationError on a malformed (non-JSON) body', async () => {
    const { database } = makeDatabase();
    const integrationService = { resolveShopHolders: vi.fn() } as unknown as IntegrationService;
    const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

    const rawBody = 'not json';
    await expect(service.handle('shop/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws ValidationError when shop_domain is missing', async () => {
    const { database } = makeDatabase();
    const integrationService = { resolveShopHolders: vi.fn() } as unknown as IntegrationService;
    const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

    const rawBody = JSON.stringify({});
    await expect(service.handle('shop/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
