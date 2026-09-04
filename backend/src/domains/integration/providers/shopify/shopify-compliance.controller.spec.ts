import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShopifyComplianceController } from './shopify-compliance.controller';
import { ShopifyComplianceService } from './shopify-compliance.service';
import { AuthGuard } from '../../../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../../../common/errors/all-exceptions.filter';
import { registerHttpLogging } from '../../../../common/logging/http-logging.hook';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import { UnauthenticatedError } from '../../../../common/errors/app-error';

/**
 * Workspace-agnostic, `@Public()` — no session, no `:workspaceId` in the
 * URL (Shopify's app-level compliance webhooks call one fixed URL for
 * every shop). Real authentication is `ShopifyComplianceService`'s HMAC
 * check, so this spec mocks the service and only proves routing/status
 * codes, matching WebhookController's own e2e spec style.
 */
describe('ShopifyComplianceController (e2e)', () => {
  let app: NestFastifyApplication;

  const complianceService = {
    handle: vi.fn(async (topic: string, rawBody: string, headers: Record<string, string>) => void [topic, rawBody, headers]),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [ShopifyComplianceController],
      providers: [{ provide: ShopifyComplianceService, useValue: complianceService }, { provide: APP_GUARD, useClass: AuthGuard }],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { rawBody: true });
    app.useGlobalFilters(new AllExceptionsFilter(new StructuredLoggerService()));
    registerHttpLogging(app.getHttpAdapter().getInstance(), new StructuredLoggerService());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    await app.close();
  });

  beforeEach(() => {
    complianceService.handle.mockClear();
  });

  it('accepts a delivery with no bearer token — @Public(), signature check is inside the service', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/integrations/shopify/compliance',
      headers: { 'x-shopify-topic': 'shop/redact' },
      payload: { shop_domain: 'wavyfyy.myshopify.com' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(complianceService.handle).toHaveBeenCalledTimes(1);
    const [topic, rawBody, headers] = complianceService.handle.mock.calls[0] as [string, string, Record<string, string>];
    expect(topic).toBe('shop/redact');
    expect(JSON.parse(rawBody)).toEqual({ shop_domain: 'wavyfyy.myshopify.com' });
    expect(headers['x-shopify-topic']).toBe('shop/redact');
  });

  it('returns 401 when the service rejects the signature', async () => {
    complianceService.handle.mockRejectedValueOnce(new UnauthenticatedError('Webhook signature verification failed.'));

    const res = await app.inject({
      method: 'POST',
      url: '/integrations/shopify/compliance',
      headers: { 'x-shopify-topic': 'customers/redact' },
      payload: { shop_domain: 'wavyfyy.myshopify.com' },
    });

    expect(res.statusCode).toBe(401);
  });

  it('passes an empty topic through rather than failing routing when the header is absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/integrations/shopify/compliance',
      payload: { shop_domain: 'wavyfyy.myshopify.com' },
    });

    expect(res.statusCode).toBe(200);
    const [topic] = complianceService.handle.mock.calls[0] as [string, string, Record<string, string>];
    expect(topic).toBe('');
  });
});
