import { SetMetadata } from '@nestjs/common';

export const ALLOW_QUERY_TOKEN_KEY = 'allowQueryToken';

/**
 * Lets AuthGuard accept the Clerk session token via a `?token=` query
 * param, in addition to the Authorization header. Scoped per-route
 * (opt-in metadata, same mechanism as @Public()) rather than a global
 * change to AuthGuard, since a top-level browser navigation (e.g.
 * Shopify OAuth start — see shopify-oauth.controller.ts) can't attach
 * custom headers, but every other route should keep requiring the
 * header so a token doesn't casually end up in query strings/logs.
 */
export const AllowQueryToken = () => SetMetadata(ALLOW_QUERY_TOKEN_KEY, true);
