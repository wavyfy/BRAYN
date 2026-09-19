import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimitError } from '../errors/app-error';
import { RequestContext } from '../logging/request-context';
import { StructuredLoggerService } from '../logging/structured-logger.service';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { RedisService } from './redis.service';
import { RATE_LIMIT_TIER_KEY, SKIP_RATE_LIMIT_KEY, type RateLimitTier } from './rate-limit.decorator';
import type { Env } from '../../config/env.schema';

type LimitTier = RateLimitTier | 'public';

/**
 * Doc19 Phase 17 hardening — "Rate-limit handling" (identified as
 * genuinely absent in the Phase 17 audit; confirmed no prior mechanism
 * exists anywhere in the codebase before writing this). Doc29 §13 names
 * "rate limiting" as an approved Upstash Redis workload by name — shared/
 * durable counters, not an in-memory per-instance map: this API can run
 * as more than one instance (doc29 §19 Render), and an in-memory counter
 * would under-count real traffic and give a false impression of global
 * protection the moment more than one instance is actually running.
 *
 * Registered as a second global APP_GUARD, immediately after AuthGuard
 * (see app.module.ts provider order — Nest runs multiple APP_GUARD
 * providers in registration order, each must return true). This never
 * replaces or reorders AuthGuard/WorkspaceMembershipGuard and never
 * grants access either of them would deny — it only adds one more gate
 * a request must also pass.
 *
 * Identity: Clerk's verified `userId` (sub), already set on
 * RequestContext by AuthGuard by the time this guard runs — the
 * strongest identity actually available at this point (doc03 rule 3 —
 * never a client-provided header/id; WorkspaceMembershipGuard's internal
 * `actorUserId`/`workspaceId` aren't resolved yet at this point in the
 * pipeline, since it runs later, at controller/method level). For a
 * `@Public()` route reached with no verified identity (only Shopify
 * OAuth `start`/`callback` reach here unskipped — webhook/compliance
 * routes opt out via `@SkipRateLimit()`, see IntegrationModule
 * controllers), falls back to the caller's resolved request IP
 * (`request.ip`, Fastify's own trust-proxy-aware value, not a raw
 * client-suppliable header) as a secondary, explicitly non-user-level
 * protection — never conflated with a real user identity.
 *
 * Fails open — on missing Redis configuration, or any Redis error at
 * runtime (network hiccup, Upstash outage) — logged, never thrown. Rate
 * limiting is an availability/hardening concern (doc18 Reliability), not
 * a security boundary; it must never become a new single point of
 * failure that takes the whole API down. A production deploy missing
 * Redis configuration is separately, loudly surfaced at startup by
 * `warnOnMissingProductionSecrets` — this guard silently failing open at
 * request time is not the only signal an operator gets.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly windowSeconds: number;
  private readonly maxByTier: Record<LimitTier, number>;

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
    config: ConfigService<Env, true>,
    private readonly logger: StructuredLoggerService,
  ) {
    this.windowSeconds = config.get('RATE_LIMIT_WINDOW_SECONDS', { infer: true });
    this.maxByTier = {
      default: config.get('RATE_LIMIT_DEFAULT_MAX', { infer: true }),
      ai: config.get('RATE_LIMIT_AI_MAX', { infer: true }),
      public: config.get('RATE_LIMIT_PUBLIC_MAX', { infer: true }),
    };
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]);
    if (skip) {
      return true;
    }

    if (!this.redis.isConfigured()) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const userId = RequestContext.get()?.userId;

    const tier: LimitTier = !isPublic && userId
      ? this.reflector.getAllAndOverride<RateLimitTier>(RATE_LIMIT_TIER_KEY, [context.getHandler(), context.getClass()]) ?? 'default'
      : 'public';
    const identity = tier === 'public' ? `ip:${request.ip}` : `user:${userId}`;
    const max = this.maxByTier[tier];

    const bucket = Math.floor(Date.now() / 1000 / this.windowSeconds);
    const key = `ratelimit:${tier}:${identity}:${bucket}`;

    let count: number;
    try {
      count = await this.redis.incrementWithExpiry(key, this.windowSeconds);
    } catch (error) {
      this.logger.event('error', 'Rate limit check failed — failing open', 'RateLimitGuard', {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        tier,
      });
      return true;
    }

    if (count > max) {
      const secondsIntoWindow = Math.floor(Date.now() / 1000) - bucket * this.windowSeconds;
      const retryAfterSeconds = this.windowSeconds - secondsIntoWindow;
      const reply = context.switchToHttp().getResponse<FastifyReply>();
      reply.header('Retry-After', retryAfterSeconds);

      this.logger.event('warn', 'Rate limit exceeded', 'RateLimitGuard', {
        tier,
        identity,
        count,
        max,
      });

      throw new RateLimitError();
    }

    return true;
  }
}
