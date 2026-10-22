import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { FastifyServerOptions } from 'fastify';
import type { Env } from '../../config/env.schema';

/**
 * Fastify server options for the API (`main.ts`). Kept out of `main.ts`
 * so specs can build a server with exactly the production settings.
 */
export function fastifyAdapterOptions(env: Pick<Env, 'TRUST_PROXY_HOPS'>): FastifyServerOptions {
  return {
    // A hop count, never `true`: only the rightmost TRUST_PROXY_HOPS
    // X-Forwarded-For entries (appended by our own proxies) are trusted, so
    // `request.ip` can't be spoofed by a client-set header. See the env
    // schema's TRUST_PROXY_HOPS comment.
    trustProxy: env.TRUST_PROXY_HOPS || false,
    // Honor an upstream correlation id if one was already assigned,
    // otherwise generate one — see "18. BRAYN Security, Observability &
    // Reliability" (Correlation & Traceability).
    genReqId: (request: IncomingMessage) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    },
  };
}
