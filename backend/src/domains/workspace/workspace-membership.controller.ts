import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { UnauthenticatedError, UnauthorizedError } from '../../common/errors/app-error';
import { RequestContext } from '../../common/logging/request-context';
import { UserService } from './user.service';
import { WorkspaceMembershipService } from './workspace-membership.service';
import { addMemberSchema, type AddMemberInput, type WorkspaceRole } from './dto/add-member.schema';

/** Doc 28 Phase 1 Permission Matrix — "User/role management": Full (Owner), Manage (Admin), none for other roles. */
const MEMBERSHIP_MANAGE_ROLES: readonly WorkspaceRole[] = ['owner', 'admin'];

/**
 * Protected by the global AuthGuard by default (Step 6) — no @Public().
 * Tenant-isolated and role-gated (doc 28 — Tenant Isolation, Permission
 * Enforcement, Phase 1 Permission Matrix): the caller must already be a
 * member of the target workspace to see its membership, and must be an
 * owner/admin member to change it. `workspaceId` is client-supplied
 * (URL param) so it is never trusted as authorization on its own.
 */
@Controller('workspaces/:workspaceId/members')
export class WorkspaceMembershipController {
  constructor(
    private readonly membershipService: WorkspaceMembershipService,
    private readonly userService: UserService,
  ) {}

  @Post()
  async addMember(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(addMemberSchema))
    body: AddMemberInput,
  ) {
    const caller = await this.requireMembership(workspaceId);
    if (!MEMBERSHIP_MANAGE_ROLES.includes(caller.role)) {
      throw new UnauthorizedError('Only the workspace owner or an admin can manage membership.');
    }

    return this.membershipService.addMember(workspaceId, body.userId, body.role);
  }

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    await this.requireMembership(workspaceId);

    return this.membershipService.listByWorkspace(workspaceId);
  }

  /** Resolves the caller's own membership in the target workspace, or rejects. */
  private async requireMembership(workspaceId: string) {
    const clerkUserId = RequestContext.get()?.userId;
    if (!clerkUserId) {
      throw new UnauthenticatedError('A bearer token is required.');
    }

    const caller = await this.userService.findOrCreateByClerkId(clerkUserId);
    const membership = await this.membershipService.findMembership(workspaceId, caller.id);
    if (!membership) {
      throw new UnauthorizedError('You are not a member of this workspace.');
    }

    return membership;
  }
}
