import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { UnauthenticatedError } from '../../../../common/errors/app-error';
import { RequestContext } from '../../../../common/logging/request-context';
import { ShopifyOAuthHandoffService } from './shopify-oauth-handoff.service';

/**
 * Authenticates the Shopify OAuth `/start` top-level navigation via a
 * single-use opaque handoff token (doc 20 Part 4B) instead of a Clerk
 * bearer token — `start` is @Public() specifically so this guard, not
 * the global AuthGuard, is what authenticates it. On success it
 * populates RequestContext/`request.userId` exactly like AuthGuard does,
 * so WorkspaceMembershipGuard (which must run after this one — see
 * shopify-oauth.controller.ts) needs no changes of its own.
 */
@Injectable()
export class ShopifyOAuthHandoffGuard implements CanActivate {
  constructor(private readonly handoffService: ShopifyOAuthHandoffService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest<{ Params: { workspaceId: string } }>>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthenticatedError('A handoff token is required.');
    }

    const claimed = await this.handoffService.consume(token, request.params.workspaceId);
    if (!claimed) {
      throw new UnauthenticatedError('The handoff token is invalid, expired, or already used.');
    }

    RequestContext.update({ userId: claimed.clerkUserId });
    Object.assign(request, { userId: claimed.clerkUserId });

    return true;
  }

  private extractToken(request: FastifyRequest): string | undefined {
    const value = (request.query as Record<string, unknown> | undefined)?.handoff;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
