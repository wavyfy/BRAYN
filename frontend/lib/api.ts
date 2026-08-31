import { auth } from '@clerk/nextjs/server';
import { env } from './env';

/** Server-side fetch to the BRAYN API, authenticated with the caller's Clerk session token. */
export async function apiFetch(path: string, init?: RequestInit) {
  const { getToken } = await auth();
  const token = await getToken();

  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`API request failed: ${res.status} ${await res.text()}`);
  }

  return res.status === 204 ? null : res.json();
}
