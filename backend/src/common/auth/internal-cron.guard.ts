import { createHash, timingSafeEqual } from 'node:crypto';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import type { Env } from '../../config/env.schema';
import { ServiceUnavailableError, UnauthenticatedError } from '../errors/app-error';
import { StructuredLoggerService } from '../logging/structured-logger.service';

/**
 * Machine-to-machine auth for internal scheduled endpoints (Milestone #5 D2 —
 * the external scheduler calls a protected internal endpoint). Used on a
 * `@Public()` route (no Clerk user exists for a cron job), so this guard is
 * the route's only authentication: `Authorization: Bearer <BRAYN_INTERNAL_CRON_SECRET>`.
 *
 * Fails closed: no secret configured → 503, never an open endpoint. Compares
 * SHA-256 digests with timingSafeEqual (equal-length buffers, no length
 * leak). Never logs the presented value.
 */
@Injectable()
export class InternalCronGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly logger: StructuredLoggerService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    verifyBearerSecret(
      context,
      this.config.get('BRAYN_INTERNAL_CRON_SECRET', { infer: true }),
      this.logger,
      'InternalCronGuard',
      'Rejected internal cron request',
    );
    return true;
  }
}

/**
 * Shared fail-closed bearer check for internal machine endpoints: no secret configured → 503; missing or wrong
 * bearer → 401 (logged without the presented value).
 */
export function verifyBearerSecret(
  context: ExecutionContext,
  secret: string | undefined,
  logger: StructuredLoggerService,
  source: string,
  rejectionMessage: string,
): void {
  if (!secret) {
    throw new ServiceUnavailableError();
  }

  const request = context.switchToHttp().getRequest<FastifyRequest>();
  const header = request.headers.authorization;
  const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

  if (!presented || !timingSafeEqual(digest(presented), digest(secret))) {
    logger.event('warn', rejectionMessage, source, {
      reason: presented ? 'invalid_secret' : 'missing_secret',
      ip: request.ip,
      path: request.url,
    });
    throw new UnauthenticatedError();
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
