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
import { ConflictError, RateLimitError, UnauthenticatedError, UnauthorizedError } from '../../common/errors/app-error';

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

  it('accepts a valid application/json event with no bearer token — @Public(), no Clerk session exists for an anonymous visitor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events?key=write_key_1',
      payload: validBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'accepted' });
    expect(websiteEventIngestService.ingest).toHaveBeenCalledWith('ws_1', validBody, expect.objectContaining({ writeKey: 'write_key_1' }));
  });

  it('passes null when no write key is supplied in the query string', async () => {
    const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/website-events', payload: validBody });

    expect(res.statusCode).toBe(200);
    expect(websiteEventIngestService.ingest).toHaveBeenCalledWith('ws_1', validBody, expect.objectContaining({ writeKey: null }));
  });

  it('accepts a text/plain body — the SDK sends this content type deliberately to stay CORS-simple', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events?key=write_key_1',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify(validBody),
    });

    expect(res.statusCode).toBe(200);
    expect(websiteEventIngestService.ingest).toHaveBeenCalledWith('ws_1', validBody, expect.objectContaining({ writeKey: 'write_key_1' }));
  });

  it('rejects a malformed text/plain body with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events',
      headers: { 'content-type': 'text/plain' },
      payload: '{not valid json',
    });

    expect(res.statusCode).toBe(400);
    expect(websiteEventIngestService.ingest).not.toHaveBeenCalled();
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

  it('rejects an identity_signal event with no payload.email (insufficient signal) with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events',
      payload: { ...validBody, eventType: 'identity_signal' },
    });

    expect(res.statusCode).toBe(400);
    expect(websiteEventIngestService.ingest).not.toHaveBeenCalled();
  });

  it('rejects an identity_signal event with a blank payload.email with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events',
      payload: { ...validBody, eventType: 'identity_signal', payload: { email: '   ' } },
    });

    expect(res.statusCode).toBe(400);
    expect(websiteEventIngestService.ingest).not.toHaveBeenCalled();
  });

  it('accepts an identity_signal event with an email and signature (signature checked by the service)', async () => {
    const payload = { email: 'shopper@example.com', signature: 'ab'.repeat(32) };
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events?key=write_key_1',
      payload: { ...validBody, eventType: 'identity_signal', payload },
    });

    expect(res.statusCode).toBe(200);
    expect(websiteEventIngestService.ingest).toHaveBeenCalledWith(
      'ws_1',
      { ...validBody, eventType: 'identity_signal', payload },
      expect.objectContaining({ writeKey: 'write_key_1' }),
    );
  });

  it('rejects an identity_signal whose email is not a valid address with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events',
      payload: { ...validBody, eventType: 'identity_signal', payload: { email: 'not-an-email' } },
    });

    expect(res.statusCode).toBe(400);
    expect(websiteEventIngestService.ingest).not.toHaveBeenCalled();
  });

  it('rejects an identity_signal whose signature is not a string with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events',
      payload: { ...validBody, eventType: 'identity_signal', payload: { email: 'shopper@example.com', signature: 123 } },
    });

    expect(res.statusCode).toBe(400);
  });

  it('passes the request Origin header and caller IP to the service', async () => {
    await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events?key=write_key_1',
      headers: { origin: 'https://shop.example.com' },
      payload: validBody,
    });

    expect(websiteEventIngestService.ingest).toHaveBeenCalledWith(
      'ws_1',
      validBody,
      { writeKey: 'write_key_1', origin: 'https://shop.example.com', ip: expect.any(String) },
    );
  });

  it('falls back to the Referer origin when no Origin header is sent', async () => {
    await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events?key=write_key_1',
      headers: { referer: 'https://shop.example.com/products/1?x=y' },
      payload: validBody,
    });

    expect(websiteEventIngestService.ingest).toHaveBeenCalledWith('ws_1', validBody, expect.objectContaining({ origin: 'https://shop.example.com' }));
  });

  it('passes a null origin when neither header is present', async () => {
    await app.inject({ method: 'POST', url: '/workspaces/ws_1/website-events?key=write_key_1', payload: validBody });

    expect(websiteEventIngestService.ingest).toHaveBeenCalledWith('ws_1', validBody, expect.objectContaining({ origin: null }));
  });

  for (const [label, overrides] of [
    ['an occurredAt more than 5 minutes in the future', { occurredAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() }],
    ['an occurredAt older than 7 days', { occurredAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }],
    ['a payload over 4 KB', { payload: { blob: 'x'.repeat(5000) } }],
    ['a visitorId with characters outside [A-Za-z0-9_-]', { visitorId: 'visitor abc;drop' }],
    ['a sessionId longer than 128 characters', { sessionId: 's'.repeat(129) }],
  ] as const) {
    it(`rejects ${label} with 400`, async () => {
      const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/website-events', payload: { ...validBody, ...overrides } });

      expect(res.statusCode).toBe(400);
      expect(websiteEventIngestService.ingest).not.toHaveBeenCalled();
    });
  }

  it('accepts an occurredAt within the allowed window (slight clock skew)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/workspaces/ws_1/website-events',
      payload: { ...validBody, occurredAt: new Date(Date.now() + 60 * 1000).toISOString() },
    });

    expect(res.statusCode).toBe(200);
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

  it('surfaces a disallowed origin as 403', async () => {
    websiteEventIngestService.ingest.mockRejectedValueOnce(new UnauthorizedError('This origin is not allowed for this write key.'));

    const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/website-events', payload: validBody });

    expect(res.statusCode).toBe(403);
  });

  it('surfaces a rate-limited request as 429', async () => {
    websiteEventIngestService.ingest.mockRejectedValueOnce(new RateLimitError());

    const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/website-events', payload: validBody });

    expect(res.statusCode).toBe(429);
  });

  it('surfaces a session/visitor mismatch as 409', async () => {
    websiteEventIngestService.ingest.mockRejectedValueOnce(new ConflictError('This session belongs to a different visitor.'));

    const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/website-events', payload: validBody });

    expect(res.statusCode).toBe(409);
  });

  it('surfaces a missing/invalid write key as 401', async () => {
    websiteEventIngestService.ingest.mockRejectedValueOnce(new UnauthenticatedError('Missing or invalid write key.'));

    const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/website-events', payload: validBody });

    expect(res.statusCode).toBe(401);
  });

  it('returns duplicate for a redelivered eventId', async () => {
    websiteEventIngestService.ingest.mockResolvedValueOnce({ status: 'duplicate' });

    const res = await app.inject({ method: 'POST', url: '/workspaces/ws_1/website-events', payload: validBody });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'duplicate' });
  });
});
