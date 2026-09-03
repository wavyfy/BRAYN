import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from './auth.guard';
import { Public } from './public.decorator';
import { AllExceptionsFilter } from '../errors/all-exceptions.filter';
import { StructuredLoggerService } from '../logging/structured-logger.service';

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === 'valid-token') {
      return { sub: 'user_123' };
    }
    throw new Error('invalid token');
  }),
}));

@Controller('test')
class ProtectedController {
  @Get('secure')
  @UseGuards(AuthGuard)
  secure() {
    return { ok: true };
  }

  @Get('open')
  @UseGuards(AuthGuard)
  @Public()
  open() {
    return { ok: true };
  }
}

/**
 * ignoreEnvFile: true — ConfigModule.forRoot() reloads backend/.env by
 * default, which would silently repopulate a var these tests deleted
 * from process.env. See database.service.spec.ts for the same fix.
 */
async function buildApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
    controllers: [ProtectedController],
    providers: [AuthGuard],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter(new StructuredLoggerService()));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('AuthGuard (e2e) — Clerk configured', () => {
  let app: NestFastifyApplication;
  const originalSecret = process.env.CLERK_SECRET_KEY;

  beforeAll(async () => {
    process.env.CLERK_SECRET_KEY = 'test-secret';
    app = await buildApp();
  });

  afterAll(async () => {
    process.env.CLERK_SECRET_KEY = originalSecret;
    await app.close();
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/secure' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a header without the Bearer scheme', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test/secure',
      headers: { authorization: 'garbage' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a bearer token that fails verification', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test/secure',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test/secure',
      headers: { authorization: 'Bearer valid-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('AuthGuard (e2e) — Clerk not configured', () => {
  let app: NestFastifyApplication;
  const originalSecret = process.env.CLERK_SECRET_KEY;

  beforeAll(async () => {
    delete process.env.CLERK_SECRET_KEY;
    app = await buildApp();
  });

  afterAll(async () => {
    process.env.CLERK_SECRET_KEY = originalSecret;
    await app.close();
  });

  afterEach(() => {
    delete process.env.CLERK_SECRET_KEY;
  });

  it('fails closed with a provider error instead of allowing the request through', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/test/secure',
      headers: { authorization: 'Bearer anything' },
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('PROVIDER_ERROR');
  });

  it('still lets a @Public() route through with no token and no Clerk configured', async () => {
    const res = await app.inject({ method: 'GET', url: '/test/open' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
