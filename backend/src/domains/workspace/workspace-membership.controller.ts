import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { WorkspaceMembershipService } from './workspace-membership.service';
import { WorkspaceMembershipGuard } from './workspace-membership.guard';
import { RequireWorkspaceRole } from './require-workspace-role.decorator';
import { addMemberSchema, type AddMemberInput } from './dto/add-member.schema';

/**
 * Protected by the global AuthGuard by default (Step 6) — no @Public().
 * Tenant-isolated and role-gated via WorkspaceMembershipGuard (doc 28 —
 * Tenant Isolation, Permission Enforcement, Phase 1 Permission Matrix):
 * the caller must already be a member of the target workspace to see its
 * membership, and must be an owner/admin member to change it.
 * `workspaceId` is client-supplied (URL param) so it is never trusted as
 * authorization on its own.
 */
@Controller('workspaces/:workspaceId/members')
@UseGuards(WorkspaceMembershipGuard)
export class WorkspaceMembershipController {
  constructor(private readonly membershipService: WorkspaceMembershipService) {}

  @Post()
  @RequireWorkspaceRole('owner', 'admin')
  async addMember(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(addMemberSchema))
    body: AddMemberInput,
  ) {
    return this.membershipService.addMember(workspaceId, body.userId, body.role);
  }

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    return this.membershipService.listByWorkspace(workspaceId);
  }
}
