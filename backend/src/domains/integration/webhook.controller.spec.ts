import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhookController } from './webhook.controller';
import { WebhookIngestService } from './webhook-ingest.service';
import { AuthGuard } from '../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { registerHttpLogging } from '../../common/logging/http-logging.hook';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { ConflictError, NotFoundError, UnauthenticatedError } from '../../common/errors/app-error';

describe('WebhookController (e2e)', () => {
  let app: NestFastifyApplication;

  const webhookIngestService = {
    ingest: vi.fn(async () => ({ status: 'accepted' as const, webhookEventId: 'evt_1' })),
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [WebhookController],
      providers: [{ provide: WebhookIngestService, useValue: webhookIngestService }, { provide: APP_GUARD, useClass: AuthGuard }],
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
    webhookIngestService.ingest.mockClear();
  });

  it('accepts a delivery with no bearer token — @Public(), signature check is the real auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/integrations/shopify/webhooks',
      headers: { 'x-shopify-topic': 'customers/update' },
      payload: { id: 1 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'accepted', webhookEventId: 'evt_1' });
    expect(webhookIngestService.ingest).toHaveBeenCalledTimes(1);
    const [workspaceId, provider, rawBody, headers] = webhookIngestService.ingest.mock.calls[0] as unknown as [
      string,
      string,
      string,
      Record<string, string>,
    ];
    expect(workspaceId).toBe('ws_1');
    expect(provider).toBe('shopify');
    expect(rawBody).toBe('{"id":1}');
    expect(headers['x-shopify-topic']).toBe('customers/update');
  });

  it('surfaces a bad signature as 401', async () => {
    webhookIngestService.ingest.mockRejectedValueOnce(new UnauthenticatedError('Webhook signature verification failed.'));

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/integrations/shopify/webhooks',
      payload: { id: 1 },
    });

    expect(res.statusCode).toBe(401);
  });

  it('surfaces an unknown workspace/provider connection as 404', async () => {
    webhookIngestService.ingest.mockRejectedValueOnce(new NotFoundError('This workspace has no connection for that provider.'));

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/integrations/shopify/webhooks',
      payload: { id: 1 },
    });

    expect(res.statusCode).toBe(404);
  });

  it('surfaces a disconnected integration as 409', async () => {
    webhookIngestService.ingest.mockRejectedValueOnce(new ConflictError('Cannot process a webhook for a disconnected integration.'));

    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/integrations/shopify/webhooks',
      payload: { id: 1 },
    });

    expect(res.statusCode).toBe(409);
  });
});
