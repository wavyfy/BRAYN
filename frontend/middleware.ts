import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';

const isPublicRoute = createRouteMatcher(['/sign-in(.*)']);

/**
 * F1 (Nov 26, 2026 smoke test): an App Router client navigation (RSC fetch, `Sec-Fetch-Dest: empty`) whose
 * short-lived `__session` token has just expired cannot be refreshed by Clerk — its handshake only runs on document
 * requests — so Clerk reports it signed out and `auth.protect()` redirects it to /sign-in although the session is
 * valid (a reload of the same URL works: the document request handshakes). When the browser still holds a signed-in
 * Clerk session, answer such a request with a non-RSC response instead: Next's router then performs a full document
 * navigation to the same URL, which refreshes the token via the handshake (or, if the session really ended, reaches
 * the normal sign-in redirect). Server Actions (POST, `Next-Action`) are not navigations and keep Clerk's behaviour.
 */
function isStaleSessionClientNavigation(req: NextRequest): boolean {
  // Next strips its own `RSC` header and `_rsc` query before middleware runs; what middleware sees of a client
  // navigation/prefetch is `Next-Url` on a non-document GET — the same signal Clerk uses to tell one apart.
  if (req.method !== 'GET' || !req.headers.has('next-url') || req.headers.has('next-action')) return false;
  if (['document', 'iframe'].includes(req.headers.get('sec-fetch-dest') ?? '')) return false;
  const cookies = req.cookies.getAll();
  // Clerk sets `__client_uat` (optionally suffixed per instance) to the last sign-in time, `0` once signed out.
  const signedInClient = cookies.some((c) => /^__client_uat(_.+)?$/.test(c.name) && Number(c.value) > 0);
  const hasSessionCookie = cookies.some((c) => /^__session(_.+)?$/.test(c.name) && c.value !== '');
  return signedInClient && hasSessionCookie;
}

export default clerkMiddleware(
  async (auth, req) => {
    if (isPublicRoute(req)) return;
    if (isStaleSessionClientNavigation(req) && !(await auth()).userId) {
      return new NextResponse(null, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }
    await auth.protect();
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
