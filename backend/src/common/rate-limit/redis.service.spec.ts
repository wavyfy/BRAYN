import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';
import type { Env } from '../../config/env.schema';

const { incr, expire, exec, pipeline, constructorCalls } = vi.hoisted(() => {
  const incr = vi.fn();
  const expire = vi.fn();
  const exec = vi.fn();
  const pipeline = vi.fn(() => ({ incr, expire, exec }));
  const constructorCalls = { count: 0 };
  return { incr, expire, exec, pipeline, constructorCalls };
});

// `Redis` itself is the class here (not wrapped in an extra vi.fn()) — a
// real, directly-exported class is the only reliably `new`-able mock shape;
// construction is tracked via `constructorCalls` instead of vi.fn() call tracking.
vi.mock('@upstash/redis', () => ({
  Redis: class MockRedisClient {
    constructor() {
      constructorCalls.count++;
    }
    pipeline() {
      return pipeline();
    }
  },
}));

function makeConfig(overrides: Partial<Pick<Env, 'UPSTASH_REDIS_REST_URL' | 'UPSTASH_REDIS_REST_TOKEN'>> = {}): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'test-token',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

describe('RedisService', () => {
  beforeEach(() => {
    incr.mockClear();
    expire.mockClear();
    exec.mockClear();
    pipeline.mockClear();
    constructorCalls.count = 0;
  });

  describe('isConfigured()', () => {
    it('is true when both URL and token are set', () => {
      const service = new RedisService(makeConfig());
      expect(service.isConfigured()).toBe(true);
    });

    it('is false when the URL is missing', () => {
      const service = new RedisService(makeConfig({ UPSTASH_REDIS_REST_URL: undefined }));
      expect(service.isConfigured()).toBe(false);
    });

    it('is false when the token is missing', () => {
      const service = new RedisService(makeConfig({ UPSTASH_REDIS_REST_TOKEN: undefined }));
      expect(service.isConfigured()).toBe(false);
    });
  });

  describe('incrementWithExpiry()', () => {
    it('pipelines INCR and EXPIRE in one round trip and returns the new count', async () => {
      exec.mockResolvedValue([3, 1]);
      const service = new RedisService(makeConfig());

      const count = await service.incrementWithExpiry('ratelimit:default:user:u1:100', 60);

      expect(incr).toHaveBeenCalledWith('ratelimit:default:user:u1:100');
      expect(expire).toHaveBeenCalledWith('ratelimit:default:user:u1:100', 60);
      expect(count).toBe(3);
    });

    it('reuses the same client across calls instead of reconnecting each time', async () => {
      exec.mockResolvedValue([1, 1]);
      const service = new RedisService(makeConfig());

      await service.incrementWithExpiry('k1', 60);
      await service.incrementWithExpiry('k2', 60);

      expect(constructorCalls.count).toBe(1);
    });

    it('throws when Redis is not configured, rather than silently no-op-ing', async () => {
      const service = new RedisService(makeConfig({ UPSTASH_REDIS_REST_URL: undefined }));

      await expect(service.incrementWithExpiry('k1', 60)).rejects.toThrow('Upstash Redis is not configured.');
    });
  });
});
