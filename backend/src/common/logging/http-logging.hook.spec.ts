import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Controller, Get } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerHttpLogging } from './http-logging.hook';
import { StructuredLoggerService } from './structured-logger.service';

@Controller('test')
class PingController {
  @Get('ping')
  ping() {
    return { pong: true };
  }

  @Get('search')
  search() {
    return { ok: true };
  }
}

describe('registerHttpLogging (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PingController],
    }).compile();

    const adapter = new FastifyAdapter({
      genReqId: (request: IncomingMessage) => {
        const incoming = request.headers['x-request-id'];
        return typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
      },
    });

    app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
    registerHttpLogging(app.getHttpAdapter().getInstance(), new StructuredLoggerService());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('generates a request id and returns it on the response', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/ping' });

    expect(res.statusCode).toBe(200);
    expect(typeof res.headers['x-request-id']).toBe('string');
  });

  it('honors an incoming x-request-id header instead of generating one', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test/ping',
      headers: { 'x-request-id': 'client-supplied-id' },
    });

    expect(res.headers['x-request-id']).toBe('client-supplied-id');
  });

  it('logs the request path without the query string (search terms can contain PII, e.g. a customer email)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await app.inject({ method: 'GET', url: '/test/search?q=jane%40example.com' });

    const httpLine = logSpy.mock.calls.map((call) => JSON.parse(call[0] as string)).find((line) => line.context === 'HTTP');
    expect(httpLine).toBeDefined();
    expect(httpLine.path).toBe('/test/search');
    expect(httpLine.message).toBe('GET /test/search');
    expect(JSON.stringify(httpLine)).not.toContain('jane@example.com');
    expect(JSON.stringify(httpLine)).not.toContain('q=');

    logSpy.mockRestore();
  });
});
