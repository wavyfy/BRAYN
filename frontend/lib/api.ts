import { auth } from '@clerk/nextjs/server';
import { env } from './env';

/**
 * Structured API failure — mirrors the canonical error envelope every
 * BRAYN endpoint returns (backend AllExceptionsFilter / doc 23 Error
 * Contract: `{ error: { code, message, requestId } }`). `message` is
 * always the safe, user-facing text the backend already vetted — the
 * filter never lets internal detail reach a client, expected or not.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON error body (e.g. a proxy/edge failure) — fall through to the generic message below.
  }

  const errorBody = (body as { error?: { code?: string; message?: string | string[]; requestId?: string } } | null)
    ?.error;
  const message = Array.isArray(errorBody?.message)
    ? errorBody.message.join(' ')
    : (errorBody?.message ?? `Request failed with status ${res.status}.`);

  return new ApiError(res.status, errorBody?.code ?? 'UNKNOWN_ERROR', message, errorBody?.requestId);
}

/**
 * Server-side fetch to the BRAYN API, authenticated with the caller's
 * Clerk session token. Throws `ApiError` (never a raw `Error`) for any
 * non-2xx response, so callers can distinguish expected API failures
 * (401/403/404/409/422 — `err instanceof ApiError`) from unexpected ones.
 * Generic and reusable: carries no route- or domain-specific behavior.
 */
export async function apiFetch(path: string, init?: RequestInit) {
  const { getToken } = await auth();
  const token = await getToken();

  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // Only bodyless requests (e.g. POST .../import, DELETE .../:provider) skip this —
      // Fastify rejects a declared JSON content-type paired with a genuinely empty body.
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    throw await toApiError(res);
  }

  return res.status === 204 ? null : res.json();
}
