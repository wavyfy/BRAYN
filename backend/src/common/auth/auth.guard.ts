import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { verifyToken } from '@clerk/backend';
import type { FastifyRequest } from 'fastify';
import { ProviderError, UnauthenticatedError } from '../errors/app-error';
import { RequestContext } from '../logging/request-context';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { Env } from '../../config/env.schema';

/**
 * Verifies the caller's Clerk session token (doc 29 §11 — Clerk is the
 * locked auth provider). Registered globally as APP_GUARD (see
 * app.module.ts) — every route requires a valid session unless marked
 * with @Public(), so a new controller is secure by default rather than
 * depending on someone remembering to add a guard.
 *
 * Authentication only establishes *who* the caller is — see
 * "05. BRAYN Workspace, Identity & Permissions": it does not determine
 * what they're allowed to do, and it does not resolve workspace
 * membership (that requires the Workspace domain + a database, neither
 * of which exist yet).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthenticatedError('A bearer token is required.');
    }

    const secretKey = this.config.get('CLERK_SECRET_KEY', { infer: true });
    if (!secretKey) {
      // Fail closed rather than silently letting an unverifiable request
      // through — see "18. BRAYN Security, Observability & Reliability".
      throw new ProviderError('Authentication provider is not configured.');
    }

    let claims: { sub: string };
    try {
      claims = await verifyToken(token, { secretKey });
    } catch {
      throw new UnauthenticatedError('The provided session token is invalid.');
    }

    RequestContext.update({ userId: claims.sub });
    Object.assign(request, { userId: claims.sub });

    return true;
  }

  private extractBearerToken(request: FastifyRequest): string | undefined {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return undefined;
    }
    return header.slice('Bearer '.length).trim() || undefined;
  }
}
