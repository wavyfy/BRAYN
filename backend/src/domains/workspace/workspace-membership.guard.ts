import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { UnauthenticatedError, UnauthorizedError } from '../../common/errors/app-error';
import { RequestContext } from '../../common/logging/request-context';
import { UserService } from './user.service';
import { WorkspaceMembershipService } from './workspace-membership.service';
import { WORKSPACE_ROLES_KEY } from './require-workspace-role.decorator';
import type { WorkspaceRole } from './dto/add-member.schema';

/**
 * Centralizes doc 05/28's Authorization flow step: Authenticated User ->
 * Workspace Membership -> (optional) Required Role. Reads `:workspaceId`
 * from the route params, so every controller using this guard must name
 * its param `workspaceId`. `workspaceId` is client-supplied and never
 * trusted as authorization on its own (doc 28 — Tenant Isolation).
 *
 * On success, sets RequestContext.workspaceId — closing the slot
 * request-context.ts left open pending exactly this (doc 18 —
 * Correlation & Traceability), now that it's actually resolvable. Also
 * sets `actorUserId`/`actorRole` (the internal user id and resolved
 * role this guard already computed) so ProtectedDataAccessInterceptor
 * can record protected-data access without this guard needing to know
 * anything about that interceptor.
 */
@Injectable()
export class WorkspaceMembershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly userService: UserService,
    private readonly membershipService: WorkspaceMembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles =
      this.reflector.getAllAndOverride<WorkspaceRole[]>(WORKSPACE_ROLES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    const request = context.switchToHttp().getRequest<FastifyRequest<{ Params: { workspaceId: string } }>>();
    const workspaceId = request.params.workspaceId;

    const clerkUserId = RequestContext.get()?.userId;
    if (!clerkUserId) {
      throw new UnauthenticatedError('A bearer token is required.');
    }

    const caller = await this.userService.findOrCreateByClerkId(clerkUserId);
    const membership = await this.membershipService.findMembership(workspaceId, caller.id);
    if (!membership) {
      throw new UnauthorizedError('You are not a member of this workspace.');
    }

    if (requiredRoles.length > 0 && !requiredRoles.includes(membership.role)) {
      throw new UnauthorizedError('Your role does not permit this action.');
    }

    RequestContext.update({ workspaceId, actorUserId: caller.id, actorRole: membership.role });

    return true;
  }
}
