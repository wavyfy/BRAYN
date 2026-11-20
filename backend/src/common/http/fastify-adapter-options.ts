import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyServerOptions } from 'fastify';

/**
 * CORS for the API (`main.ts`): only the frontend origin, with credentials. `methods` is explicit because
 * @fastify/cors 10+ narrowed its default to GET,HEAD,POST; this keeps the pre-upgrade set.
 */
export function corsOptions(frontendUrl: string): Parameters<NestFastifyApplication['enableCors']>[0] {
  return { origin: frontendUrl, credentials: true, methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'] };
}
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
    //
    // Passed as a function, not a number: Fastify 5.12+ makes a numeric
    // trustProxy fail closed (never trusts X-Forwarded-For, so request.ip
    // would be Render's edge for every client and collapse per-IP rate
    // limits). `i < hops` is exactly proxy-addr's numeric hop-count rule,
    // i.e. the behavior verified in production with TRUST_PROXY_HOPS=3.
    trustProxy: env.TRUST_PROXY_HOPS > 0 ? (_address: string, hop: number) => hop < env.TRUST_PROXY_HOPS : false,
    // Honor an upstream correlation id if one was already assigned,
    // otherwise generate one — see "18. BRAYN Security, Observability &
    // Reliability" (Correlation & Traceability).
    genReqId: (request: IncomingMessage) => {
      const incoming = request.headers['x-request-id'];
      return typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    },
  };
}
