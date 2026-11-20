/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Capture what middleware.ts hands to Clerk; keep Clerk's real route matcher so the public-route list is tested for real.
const captured = vi.hoisted(() => ({ handler: null as null | ((auth: unknown, req: NextRequest) => Promise<void>), options: null as unknown }));
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

async function protects(path: string): Promise<boolean> {
  const protect = vi.fn(async () => undefined);
  await captured.handler!({ protect }, new NextRequest(`https://app.example${path}`));
  return protect.mock.calls.length === 1;
}

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
});
