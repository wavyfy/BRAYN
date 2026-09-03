import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts a route out of the global AuthGuard (see auth.guard.ts). AuthGuard
 * is secure-by-default once registered as APP_GUARD — this is the
 * explicit, visible escape hatch rather than an easy-to-forget opt-in.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
