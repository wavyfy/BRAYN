import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Controller, Get } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerHttpLogging } from './http-logging.hook';
import { StructuredLoggerService } from './structured-logger.service';

@Controller('test')
class PingController {
  @Get('ping')
  ping() {
    return { pong: true };
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
});
