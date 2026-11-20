import { Controller, Get } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { corsOptions } from './fastify-adapter-options';

@Controller('x')
class PingController {
  @Get()
  ping() {
    return { ok: true };
  }
}

const FRONTEND = 'https://app.example';

/** Through the real Nest Fastify adapter + @fastify/cors, exactly as main.ts wires it. */
describe('corsOptions (Nest 11 / @fastify/cors 11) — regression', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [PingController] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.enableCors(corsOptions(FRONTEND));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const preflight = (origin: string, method: string) =>
    app.inject({ method: 'OPTIONS', url: '/x', headers: { origin, 'access-control-request-method': method } });

  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    it(`allows a ${method} preflight from the frontend origin, with credentials`, async () => {
      const res = await preflight(FRONTEND, method);
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(String(res.headers['access-control-allow-methods']).split(',').map((m) => m.trim())).toContain(method);
    });
  }

  // A fixed string origin is always sent as-is (browsers reject the mismatch) — another origin is never echoed back.
  it('never allows another origin', async () => {
    const res = await preflight('https://evil.example', 'PATCH');
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND);
    const simple = await app.inject({ method: 'GET', url: '/x', headers: { origin: 'https://evil.example' } });
    expect(simple.headers['access-control-allow-origin']).toBe(FRONTEND);
  });
});
