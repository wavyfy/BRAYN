import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from '@upstash/redis';
import type { Env } from '../../config/env.schema';

/**
 * Thin wrapper around Upstash's REST Redis client (doc29 §13 — Upstash is
 * the approved provider, and names "rate limiting" as an approved
 * workload by name). Lazily constructs the client on first real use, same
 * fail-closed-only-when-actually-called convention as DatabaseService/
 * OpenAiAdapter — absent credentials don't crash the app at boot, only a
 * caller that actually needs Redis finds out (and RateLimitGuard treats
 * that as "not configured," failing open rather than throwing — see its
 * own doc comment).
 */
@Injectable()
export class RedisService {
  private client: Redis | undefined;

  constructor(private readonly config: ConfigService<Env, true>) {}

  isConfigured(): boolean {
    return Boolean(this.config.get('UPSTASH_REDIS_REST_URL', { infer: true }) && this.config.get('UPSTASH_REDIS_REST_TOKEN', { infer: true }));
  }

  /**
   * Fixed-window counter primitive: increments `key` and (re-)sets its
   * TTL every call. The caller is expected to fold the window boundary
   * into `key` itself (e.g. a `.../<bucket>` suffix) so each window gets
   * its own key — re-setting the same TTL value on every hit within that
   * window is harmless (the key still naturally stops being written to,
   * and expires, once the window rolls over to a new key). Pipelined so
   * INCR+EXPIRE are one round trip.
   */
  async incrementWithExpiry(key: string, windowSeconds: number): Promise<number> {
    const client = this.getClient();
    const pipeline = client.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, windowSeconds);
    const results = await pipeline.exec<[number, number]>();
    return results[0];
  }

  private getClient(): Redis {
    if (!this.client) {
      const url = this.config.get('UPSTASH_REDIS_REST_URL', { infer: true });
      const token = this.config.get('UPSTASH_REDIS_REST_TOKEN', { infer: true });
      if (!url || !token) {
        throw new Error('Upstash Redis is not configured.');
      }
      this.client = new Redis({ url, token });
    }
    return this.client;
  }
}
