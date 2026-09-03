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
    logger.event('log', `${request.method} ${request.url}`, 'HTTP', {
      method: request.method,
      path: request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime * 100) / 100,
    });
    done();
  });
}
