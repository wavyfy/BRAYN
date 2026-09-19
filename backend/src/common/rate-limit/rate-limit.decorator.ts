import { SetMetadata } from '@nestjs/common';

export const SKIP_RATE_LIMIT_KEY = 'skipRateLimit';
export const RATE_LIMIT_TIER_KEY = 'rateLimitTier';

export type RateLimitTier = 'default' | 'ai';

/**
 * Opts a route out of rate limiting entirely — reserved for provider
 * webhook/compliance endpoints (doc19 Phase 17 hardening). A provider
 * delivery is authenticated by its own signature check, not Clerk, can
 * legitimately arrive in real bursts (bulk operations, replays), and a
 * false-positive 429 risks the provider disabling the webhook
 * subscription after repeated failures — a worse outcome than the abuse
 * this guard protects against. Explicit and visible, same shape as
 * `@Public()`.
 */
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT_KEY, true);

/**
 * Marks a route as belonging to the stricter `'ai'` tier — doc12/doc18:
 * an AI call is the single most expensive request this API serves
 * (OpenAI cost + latency), unlike a normal CRUD/read request. Omitted
 * means the `'default'` tier applies.
 */
export const RateLimitTier = (tier: RateLimitTier) => SetMetadata(RATE_LIMIT_TIER_KEY, tier);
