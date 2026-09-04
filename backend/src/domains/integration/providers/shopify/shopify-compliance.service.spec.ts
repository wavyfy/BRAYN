import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ShopifyComplianceService } from './shopify-compliance.service';
import { customerDataRequests } from '../../../../database/schema/customer-data-requests';
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

function makeDatabase() {
  const values = vi.fn(async (row: Record<string, unknown>) => void row);
  const insert = vi.fn(() => ({ values }));
  return { database: { client: { insert } } as unknown as DatabaseService, insert, values };
}

describe('ShopifyComplianceService', () => {
  it('rejects a request with a missing/invalid signature', async () => {
    const { database } = makeDatabase();
    const integrationService = { findByShopDomain: vi.fn() } as unknown as IntegrationService;
    const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

    const rawBody = JSON.stringify({ shop_domain: 'wavyfyy.myshopify.com' });

    await expect(service.handle('shop/redact', rawBody, { 'x-shopify-hmac-sha256': 'not-the-right-signature' })).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('fails closed when SHOPIFY_APP_CLIENT_SECRET is not configured', async () => {
    const { database } = makeDatabase();
    const integrationService = { findByShopDomain: vi.fn() } as unknown as IntegrationService;
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
      const integrationService = { findByShopDomain: vi.fn(async () => integration) } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({
        shop_domain: 'wavyfyy.myshopify.com',
        customer: { id: 191167, email: 'jane@example.com' },
        orders_requested: [1, 2, 3],
      });

      await service.handle('customers/data_request', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) });

      expect(integrationService.findByShopDomain).toHaveBeenCalledWith('wavyfyy.myshopify.com');
      expect(insert).toHaveBeenCalledWith(customerDataRequests);
      expect(values).toHaveBeenCalledWith({
        workspaceId: 'ws_1',
        integrationId: 'int_1',
        provider: 'shopify',
        shopDomain: 'wavyfyy.myshopify.com',
        shopifyCustomerId: '191167',
        customerEmail: 'jane@example.com',
        ordersRequested: [1, 2, 3],
      });
    });

    it('persists the request with null workspace/integration when the shop is unrecognized, and still acknowledges', async () => {
      const { database, values } = makeDatabase();
      const integrationService = { findByShopDomain: vi.fn(async () => null) } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({ shop_domain: 'unknown.myshopify.com', customer: { id: 1 } });

      await expect(service.handle('customers/data_request', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) })).resolves.toBeUndefined();

      expect(values).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: null, integrationId: null }));
    });

    it('never logs the customer email or id — only shopDomain and a resolved flag', async () => {
      const { database } = makeDatabase();
      const integration = { id: 'int_1', workspaceId: 'ws_1' };
      const integrationService = { findByShopDomain: vi.fn(async () => integration) } as unknown as IntegrationService;
      const logger = makeLogger();
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, logger);

      const rawBody = JSON.stringify({ shop_domain: 'wavyfyy.myshopify.com', customer: { id: 191167, email: 'jane@example.com' } });
      await service.handle('customers/data_request', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) });

      expect(logger.event).toHaveBeenCalledWith('log', expect.any(String), 'ShopifyComplianceService', { shopDomain: 'wavyfyy.myshopify.com', resolved: true });
      expect(JSON.stringify((logger.event as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('jane@example.com');
      expect(JSON.stringify((logger.event as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('191167');
    });
  });

  describe('customers/redact', () => {
    it('erases the customer via IntegrationService.purgeCommerceCustomer when the shop is known', async () => {
      const { database } = makeDatabase();
      const integration = { id: 'int_1', workspaceId: 'ws_1' };
      const integrationService = {
        findByShopDomain: vi.fn(async () => integration),
        purgeCommerceCustomer: vi.fn(async () => ({ found: true, canonicalCustomerRemoved: true })),
      } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({ shop_domain: 'wavyfyy.myshopify.com', customer: { id: 191167, email: 'jane@example.com' } });
      await service.handle('customers/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) });

      expect(integrationService.purgeCommerceCustomer).toHaveBeenCalledWith('ws_1', 'int_1', '191167');
    });

    it('does nothing (but still acknowledges) when the shop is unrecognized', async () => {
      const { database } = makeDatabase();
      const integrationService = {
        findByShopDomain: vi.fn(async () => null),
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
        findByShopDomain: vi.fn(async () => integration),
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
        findByShopDomain: vi.fn(async () => integration),
        eraseIntegrationForShopRedact: vi.fn(async () => ({ found: true })),
      } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({ shop_domain: 'wavyfyy.myshopify.com' });
      await service.handle('shop/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) });

      expect(integrationService.eraseIntegrationForShopRedact).toHaveBeenCalledWith('int_1');
    });

    it('does nothing (but still acknowledges) when the shop is unrecognized', async () => {
      const { database } = makeDatabase();
      const integrationService = {
        findByShopDomain: vi.fn(async () => null),
        eraseIntegrationForShopRedact: vi.fn(),
      } as unknown as IntegrationService;
      const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

      const rawBody = JSON.stringify({ shop_domain: 'unknown.myshopify.com' });
      await expect(service.handle('shop/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) })).resolves.toBeUndefined();

      expect(integrationService.eraseIntegrationForShopRedact).not.toHaveBeenCalled();
    });
  });

  it('throws ValidationError on a malformed (non-JSON) body', async () => {
    const { database } = makeDatabase();
    const integrationService = { findByShopDomain: vi.fn() } as unknown as IntegrationService;
    const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

    const rawBody = 'not json';
    await expect(service.handle('shop/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('throws ValidationError when shop_domain is missing', async () => {
    const { database } = makeDatabase();
    const integrationService = { findByShopDomain: vi.fn() } as unknown as IntegrationService;
    const service = new ShopifyComplianceService(makeConfig(), database, integrationService, makeLogger());

    const rawBody = JSON.stringify({});
    await expect(service.handle('shop/redact', rawBody, { 'x-shopify-hmac-sha256': sign(rawBody) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
