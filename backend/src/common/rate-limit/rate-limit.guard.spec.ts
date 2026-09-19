import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { Public } from '../auth/public.decorator';
import { RateLimitGuard } from './rate-limit.guard';
import { RedisService } from './redis.service';
import { SkipRateLimit, RateLimitTier } from './rate-limit.decorator';
import { AllExceptionsFilter } from '../errors/all-exceptions.filter';
import { StructuredLoggerService } from '../logging/structured-logger.service';
import { registerHttpLogging } from '../logging/http-logging.hook';
import { loadConfiguration } from '../../config/configuration';

vi.mock('@clerk/backend', () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === 'user-a') return { sub: 'user_a' };
    if (token === 'user-b') return { sub: 'user_b' };
    throw new Error('invalid token');
  }),
}));

/**
 * In-memory fake honoring RedisService's own contract — lets these tests
 * control counts deterministically without a real or mocked Upstash
 * client (that boundary is covered separately in redis.service.spec.ts).
 */
class FakeRedisService {
  private counts = new Map<string, number>();
  configured = true;
  shouldThrow = false;
  readonly keysSeen: string[] = [];

  isConfigured(): boolean {
    return this.configured;
  }

  async incrementWithExpiry(key: string): Promise<number> {
    if (this.shouldThrow) {
      throw new Error('redis unavailable');
    }
    this.keysSeen.push(key);
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
}

@Controller('rl')
class TestController {
  @Get('secure/:workspaceId')
  @UseGuards(AuthGuard, RateLimitGuard)
  secure() {
    return { ok: true };
  }

  @Get('ai')
  @UseGuards(AuthGuard, RateLimitGuard)
  @RateLimitTier('ai')
  ai() {
    return { ok: true };
  }

  @Get('public')
  @Public()
  @UseGuards(AuthGuard, RateLimitGuard)
  publicRoute() {
    return { ok: true };
  }

  @Get('webhook')
  @Public()
  @SkipRateLimit()
  @UseGuards(AuthGuard, RateLimitGuard)
  webhook() {
    return { ok: true };
  }
}

async function buildApp(fakeRedis: FakeRedisService): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [loadConfiguration] })],
    controllers: [TestController],
    providers: [AuthGuard, RateLimitGuard, StructuredLoggerService, { provide: RedisService, useValue: fakeRedis }],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  app.useGlobalFilters(new AllExceptionsFilter(new StructuredLoggerService()));
  // AuthGuard's RequestContext.update() is a no-op without an active store —
  // production wires this via the same onRequest hook (see main.ts bootstrap).
  registerHttpLogging(app.getHttpAdapter().getInstance(), new StructuredLoggerService());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('RateLimitGuard (e2e)', () => {
  let app: NestFastifyApplication;
  let redis: FakeRedisService;
  const savedEnv = {
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    RATE_LIMIT_WINDOW_SECONDS: process.env.RATE_LIMIT_WINDOW_SECONDS,
    RATE_LIMIT_DEFAULT_MAX: process.env.RATE_LIMIT_DEFAULT_MAX,
    RATE_LIMIT_AI_MAX: process.env.RATE_LIMIT_AI_MAX,
    RATE_LIMIT_PUBLIC_MAX: process.env.RATE_LIMIT_PUBLIC_MAX,
  };

  beforeAll(() => {
    process.env.CLERK_SECRET_KEY = 'test-secret';
    // A large window means these tests never straddle a bucket boundary; small
    // maxes make hitting the limit deterministic in a handful of requests.
    process.env.RATE_LIMIT_WINDOW_SECONDS = '3600';
    process.env.RATE_LIMIT_DEFAULT_MAX = '2';
    process.env.RATE_LIMIT_AI_MAX = '1';
    process.env.RATE_LIMIT_PUBLIC_MAX = '1';
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    redis = new FakeRedisService();
    app = await buildApp(redis);
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows requests below the configured limit', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } });
    const res2 = await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
  });

  it('returns 429 with the RATE_LIMITED error code once the limit is exceeded', async () => {
    await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } }); // 1
    await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } }); // 2 (== max)
    const res = await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } }); // 3 (> max)

    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('isolates rate-limit state per authenticated user — a different user is unaffected', async () => {
    await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } });
    await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } });
    await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } }); // user_a now over limit

    const res = await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-b' } });

    expect(res.statusCode).toBe(200);
  });

  it('cannot be bypassed by changing the workspaceId in the URL — the bucket is keyed on the authenticated user, not the route', async () => {
    await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } });
    await app.inject({ method: 'GET', url: '/rl/secure/ws_2', headers: { authorization: 'Bearer user-a' } });
    const res = await app.inject({ method: 'GET', url: '/rl/secure/ws_3', headers: { authorization: 'Bearer user-a' } });

    expect(res.statusCode).toBe(429);
  });

  it('still enforces normal authentication — an unauthenticated request to a protected route is rejected by AuthGuard, not rate-limited', async () => {
    const res = await app.inject({ method: 'GET', url: '/rl/secure/ws_1' });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('applies the stricter ai tier to a route tagged @RateLimitTier(\'ai\')', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/rl/ai', headers: { authorization: 'Bearer user-a' } });
    const res2 = await app.inject({ method: 'GET', url: '/rl/ai', headers: { authorization: 'Bearer user-a' } });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(429); // ai max is 1, unlike default's 2
  });

  it('the ai tier and the default tier are independent buckets for the same user', async () => {
    const aiRes = await app.inject({ method: 'GET', url: '/rl/ai', headers: { authorization: 'Bearer user-a' } }); // consumes ai's 1-request budget
    const secureRes = await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } });

    expect(aiRes.statusCode).toBe(200);
    expect(secureRes.statusCode).toBe(200); // default tier untouched by the ai-tier request
  });

  it('falls back to IP-based limiting for a @Public() route with no authenticated identity', async () => {
    const res1 = await app.inject({ method: 'GET', url: '/rl/public' });
    const res2 = await app.inject({ method: 'GET', url: '/rl/public' });

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(429); // public max is 1
    expect(redis.keysSeen.every((key) => key.startsWith('ratelimit:public:ip:'))).toBe(true);
  });

  it('never rate-limits a @SkipRateLimit() route, no matter how many requests', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/rl/webhook' });
      expect(res.statusCode).toBe(200);
    }
    expect(redis.keysSeen).toHaveLength(0);
  });

  it('fails open (allows the request) when Redis is not configured', async () => {
    redis.configured = false;

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } });
      expect(res.statusCode).toBe(200);
    }
  });

  it('fails open (allows the request) when the Redis call itself throws', async () => {
    redis.shouldThrow = true;

    const res = await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } });

    expect(res.statusCode).toBe(200);
  });

  it('the rate-limit error response and headers never expose the Upstash URL/token or any bearer token', async () => {
    await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } });
    await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } });
    const res = await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } });

    const raw = JSON.stringify(res.json()) + JSON.stringify(res.headers);
    expect(raw).not.toMatch(/token|upstash|bearer|secret/i);
  });

  it('behaves exactly like the existing route when the limit is never exceeded — response body/shape unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/rl/secure/ws_1', headers: { authorization: 'Bearer user-a' } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
