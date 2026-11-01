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
    const secret = this.config.get('BRAYN_INTERNAL_CRON_SECRET', { infer: true });
    if (!secret) {
      throw new ServiceUnavailableError();
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;

    if (!presented || !timingSafeEqual(digest(presented), digest(secret))) {
      this.logger.event('warn', 'Rejected internal cron request', 'InternalCronGuard', {
        reason: presented ? 'invalid_secret' : 'missing_secret',
        ip: request.ip,
        path: request.url,
      });
      throw new UnauthenticatedError();
    }
    return true;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
