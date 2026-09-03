import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher(['/sign-in(.*)']);

export default clerkMiddleware(
  async (auth, req) => {
    if (!isPublicRoute(req)) {
      await auth.protect();
    }
  },
  {
    // Production-only Frontend API proxy through /__clerk (registered as this
    // instance's proxy URL in the Clerk Dashboard). Explicit here rather than
    // relying on @clerk/nextjs's own built-in auto-proxy (which enables on any
    // *.vercel.app hostname paired with a production publishable key) — that
    // heuristic doesn't distinguish Preview from Production, since Preview
    // deployments are *.vercel.app too. VERCEL_ENV is unset locally and
    // 'preview' on Preview deployments, so this only ever evaluates true on
    // Vercel Production.
    frontendApiProxy: {
      enabled: process.env.VERCEL_ENV === 'production',
      path: '/__clerk',
    },
  },
);

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)', '/(api|trpc)(.*)', '/__clerk/(.*)'],
};
