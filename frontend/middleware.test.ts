/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Capture what middleware.ts hands to Clerk; keep Clerk's real route matcher so the public-route list is tested for real.
const captured = vi.hoisted(() => ({ handler: null as null | ((auth: unknown, req: NextRequest) => Promise<unknown>), options: null as unknown }));
vi.mock('@clerk/nextjs/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clerk/nextjs/server')>()),
  clerkMiddleware: (handler: typeof captured.handler, options: unknown) => {
    captured.handler = handler;
    captured.options = options;
    return () => undefined;
  },
}));

async function load() {
  vi.resetModules();
  return import('./middleware');
}

type Call = { protected: boolean; response: Response | undefined };

/** Runs the captured handler with a Clerk auth stub: `userId` = what Clerk resolved for this request. */
async function run(path: string, init: { headers?: Record<string, string>; method?: string; userId?: string | null } = {}): Promise<Call> {
  const protect = vi.fn(async () => undefined);
  const auth = Object.assign(vi.fn(async () => ({ userId: init.userId ?? null })), { protect });
  const response = await captured.handler!(auth, new NextRequest(`https://app.example${path}`, { method: init.method, headers: init.headers }));
  return { protected: protect.mock.calls.length === 1, response: response as Response | undefined };
}

async function protects(path: string): Promise<boolean> {
  return (await run(path)).protected;
}

// An App Router client navigation (RSC fetch) as middleware receives it — captured from a real browser navigation
// on Next 15.5: Next strips `RSC` and `_rsc` before middleware; `Next-Url` and `Sec-Fetch-Dest: empty` remain.
const SIGNED_IN = '__client_uat=1795800000; __session=eyJhbGciOi.expired.token';
const rsc = (cookie: string, extra: Record<string, string> = {}) => ({
  'next-url': '/workspace/ws_1/customers',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  accept: '*/*',
  cookie,
  ...extra,
});

/** Next's matcher semantics: each entry must match the whole pathname. */
function matched(config: { matcher: string[] }, path: string): boolean {
  return config.matcher.some((m) => new RegExp(`^${m}$`).test(path));
}

describe('middleware (Clerk sign-in protection) — regression', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('requires sign-in for every workspace page and Server Action route, and only /sign-in is public', async () => {
    await load();
    for (const path of ['/', '/workspace/ws_1', '/workspace/ws_1/customers', '/workspace/ws_1/customers/c_1', '/workspace/ws_1/integrations', '/api/anything']) {
      expect(await protects(path), path).toBe(true);
    }
    for (const path of ['/sign-in', '/sign-in/factor-one']) {
      expect(await protects(path), path).toBe(false);
    }
  });

  it('runs on app routes, API routes and the Clerk proxy, but not on Next static assets', async () => {
    const { config } = await load();
    for (const path of ['/', '/workspace/ws_1/customers', '/api/x', '/__clerk/v1/client']) {
      expect(matched(config, path), path).toBe(true);
    }
    for (const path of ['/_next/static/chunks/app.js', '/favicon.ico', '/tracking.js']) {
      expect(matched(config, path), path).toBe(false);
    }
  });

  it('enables the /__clerk Frontend API proxy only on Vercel Production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    await load();
    expect(captured.options).toMatchObject({ frontendApiProxy: { enabled: true, path: '/__clerk' } });

    vi.stubEnv('VERCEL_ENV', 'preview');
    await load();
    expect(captured.options).toMatchObject({ frontendApiProxy: { enabled: false } });
  });
  describe('F1 — client navigation with an expired session token (regression)', () => {
    const DETAIL = '/workspace/ws_1/customers/c_1';

    it('answers with a non-RSC 401 (Next then reloads the page as a document, which refreshes the session) instead of redirecting to /sign-in', async () => {
      await load();
      const call = await run(DETAIL, { headers: rsc(SIGNED_IN) });
      expect(call.protected).toBe(false);
      expect(call.response?.status).toBe(401);
      expect(call.response?.headers.get('location')).toBeNull();
      expect(call.response?.headers.get('content-type') ?? '').not.toContain('text/x-component');
      expect(call.response?.headers.get('cache-control')).toBe('no-store');
    });

    it('recognises the instance-suffixed Clerk cookie names', async () => {
      await load();
      const call = await run(DETAIL, { headers: rsc('__client_uat_u57Fgn4t=1795800000; __session_u57Fgn4t=eyJ.x.y') });
      expect(call.response?.status).toBe(401);
    });

    it('keeps the normal path when the session token is valid', async () => {
      await load();
      const call = await run(DETAIL, { headers: rsc(SIGNED_IN), userId: 'user_1' });
      expect(call.protected).toBe(true);
      expect(call.response).toBeUndefined();
    });

    it('still sends a signed-out browser to sign-in (no session cookie, or __client_uat = 0)', async () => {
      await load();
      for (const cookie of ['', '__client_uat=0', '__client_uat=0; __session=eyJ.x.y', '__client_uat=1795800000']) {
        const call = await run(DETAIL, { headers: rsc(cookie) });
        expect(call.protected, cookie).toBe(true);
        expect(call.response, cookie).toBeUndefined();
      }
    });

    it('leaves document requests (Clerk handshakes those itself) and Server Actions to Clerk', async () => {
      await load();
      expect((await run('/workspace/ws_1/customers/c_1', { headers: { 'sec-fetch-dest': 'document', accept: 'text/html', cookie: SIGNED_IN } })).protected).toBe(true);
      expect((await run('/workspace/ws_1/customers/c_1', { headers: rsc(SIGNED_IN, { 'sec-fetch-dest': 'document' }) })).protected).toBe(true);
      const action = await run('/workspace/ws_1/customers/c_1', { method: 'POST', headers: rsc(SIGNED_IN, { 'next-action': 'abc', accept: 'text/x-component' }) });
      expect(action.protected).toBe(true);
      expect(action.response).toBeUndefined();
    });

    it('never touches the public sign-in route', async () => {
      await load();
      const call = await run('/sign-in', { headers: rsc(SIGNED_IN) });
      expect(call.protected).toBe(false);
      expect(call.response).toBeUndefined();
    });
  });
});
