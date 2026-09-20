import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(async () => ({ getToken: vi.fn(async () => 'test-token') })),
}));

vi.mock('./env', () => ({ env: { NEXT_PUBLIC_API_URL: 'http://api.test' } }));

import { apiFetch, ApiError } from './api';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('apiFetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns parsed JSON on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { id: 'ws_1' })));

    await expect(apiFetch('/api/v1/workspaces/ws_1')).resolves.toEqual({ id: 'ws_1' });
  });

  it('returns null for a 204 No Content response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));

    await expect(apiFetch('/api/v1/workspaces/ws_1', { method: 'DELETE' })).resolves.toBeNull();
  });

  it('throws ApiError with status/code/message parsed from the canonical error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(403, {
          error: { code: 'UNAUTHORIZED', message: 'You are not a member of this workspace.', requestId: 'req-1' },
        }),
      ),
    );

    const error = await apiFetch('/api/v1/workspaces/ws_2').catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: 'UNAUTHORIZED',
      message: 'You are not a member of this workspace.',
      requestId: 'req-1',
    });
  });

  it('joins an array validation message into one string', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(422, { error: { code: 'VALIDATION_ERROR', message: ['name is required', 'name too long'] } }),
      ),
    );

    const error: ApiError = await apiFetch('/api/v1/workspaces').catch((e) => e);

    expect(error.message).toBe('name is required name too long');
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>502</html>', { status: 502 })));

    const error: ApiError = await apiFetch('/api/v1/workspaces').catch((e) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.message).toBe('Request failed with status 502.');
  });

  describe('Content-Type header (doc 20 Part 30B)', () => {
    it('sends Content-Type: application/json when a body is present', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => jsonResponse(200, {}));
      vi.stubGlobal('fetch', fetchMock);

      await apiFetch('/api/v1/workspaces', { method: 'POST', body: JSON.stringify({ name: 'Acme' }) });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('does NOT send Content-Type: application/json for a bodyless request (e.g. POST .../import) — Fastify rejects that combination', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => jsonResponse(202, { id: 'run_1' }));
      vi.stubGlobal('fetch', fetchMock);

      await apiFetch('/api/v1/workspaces/ws_1/integrations/shopify/import', { method: 'POST' });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
    });

    it('still attaches Authorization regardless of whether a body is present', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => jsonResponse(202, { id: 'run_1' }));
      vi.stubGlobal('fetch', fetchMock);

      await apiFetch('/api/v1/workspaces/ws_1/integrations/shopify/import', { method: 'POST' });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    });

    it('preserves other caller-supplied headers on a bodyless request', async () => {
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => jsonResponse(202, { id: 'run_1' }));
      vi.stubGlobal('fetch', fetchMock);

      await apiFetch('/api/v1/workspaces/ws_1/integrations/shopify/import', {
        method: 'POST',
        headers: { 'X-Custom-Header': 'value' },
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['X-Custom-Header']).toBe('value');
    });
  });
});
