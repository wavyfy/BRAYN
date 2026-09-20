import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebsiteEventController } from './website-event.controller';
import { WebsiteEventIngestService, type WebsiteEventIngestResult } from './website-event-ingest.service';
import { AuthGuard } from '../../common/auth/auth.guard';
import { AllExceptionsFilter } from '../../common/errors/all-exceptions.filter';
import { registerHttpLogging } from '../../common/logging/http-logging.hook';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';

describe('WebsiteEventController (e2e)', () => {
  let app: NestFastifyApplication;

  const websiteEventIngestService = {
    ingest: vi.fn(async (): Promise<WebsiteEventIngestResult> => ({ status: 'accepted' })),
  };

  const validBody = {
    visitorId: 'visitor_abc',
    sessionId: 'session_abc',
    eventId: 'evt_1',
    eventType: 'page_view',
  };

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [WebsiteEventController],
      providers: [
        { provide: WebsiteEventIngestService, useValue: websiteEventIngestService },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
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
    websiteEventIngestService.ingest.mockClear();
  });

  it('accepts a valid event with no bearer token — @Public(), no Clerk session exists for an anonymous visitor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events',
      payload: validBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'accepted' });
    expect(websiteEventIngestService.ingest).toHaveBeenCalledWith('ws_1', validBody);
  });

  it('rejects a payload missing required fields with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events',
      payload: { eventType: 'page_view' },
    });

    expect(res.statusCode).toBe(400);
    expect(websiteEventIngestService.ingest).not.toHaveBeenCalled();
  });

  it('rejects an unknown eventType with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events',
      payload: { ...validBody, eventType: 'not_a_real_event' },
    });

    expect(res.statusCode).toBe(400);
    expect(websiteEventIngestService.ingest).not.toHaveBeenCalled();
  });

  it('surfaces an unconnected website_tracking provider as 404', async () => {
    websiteEventIngestService.ingest.mockRejectedValueOnce(
      new NotFoundError('This workspace has no connection for the website_tracking provider.'),
    );

    const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/website-events', payload: validBody });

    expect(res.statusCode).toBe(404);
  });

  it('surfaces a disconnected website_tracking provider as 409', async () => {
    websiteEventIngestService.ingest.mockRejectedValueOnce(
      new ConflictError('Cannot ingest a website event for a disconnected integration.'),
    );

    const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/website-events', payload: validBody });

    expect(res.statusCode).toBe(409);
  });

  it('returns duplicate for a redelivered eventId', async () => {
    websiteEventIngestService.ingest.mockResolvedValueOnce({ status: 'duplicate' });

    const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/website-events', payload: validBody });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'duplicate' });
  });
});
