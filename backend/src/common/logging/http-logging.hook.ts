import type { FastifyInstance } from 'fastify';
import { RequestContext } from './request-context';
import type { StructuredLoggerService } from './structured-logger.service';

/**
 * Wires correlation-id propagation and request logging directly into
 * Fastify's hook chain, so the logged status code reflects the *final*
 * response — including one rewritten by the exception filter — rather
 * than whatever it was when a Nest interceptor would have observed it.
 *
 * See "18. BRAYN Security, Observability & Reliability" (Logging,
 * Correlation & Traceability).
 */
export function registerHttpLogging(
  instance: FastifyInstance,
  logger: StructuredLoggerService,
): void {
  instance.addHook('onRequest', (request, reply, done) => {
    RequestContext.start({ correlationId: request.id });
    reply.header('x-request-id', request.id);
    done();
  });

  instance.addHook('onResponse', (request, reply, done) => {
    // request.url includes the query string (e.g. `?search=jane@example.com`
    // on the customer list endpoint) — never log it verbatim, or a search
    // box becomes a PII leak into every deployment's log stream.
    const path = request.url.split('?')[0];
    logger.event('log', `${request.method} ${path}`, 'HTTP', {
      method: request.method,
      path,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime * 100) / 100,
    });
    done();
  });
}
