import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { NotFoundError, UnauthenticatedError } from '../../common/errors/app-error';
import { RequestContext } from '../../common/logging/request-context';
import { WorkspaceService } from './workspace.service';
import { UserService } from './user.service';
import { WorkspaceMembershipService } from './workspace-membership.service';
import { WorkspaceMembershipGuard } from './workspace-membership.guard';
import { RequireWorkspaceRole } from './require-workspace-role.decorator';
import { createWorkspaceSchema, type CreateWorkspaceInput } from './dto/create-workspace.schema';
import { updateWorkspaceSchema, type UpdateWorkspaceInput } from './dto/update-workspace.schema';

/**
 * Protected by the global AuthGuard by default (Step 6) — no @Public().
 * Tenant-isolated (doc 28 — Tenant Isolation): `workspaceId` in the URL is
 * client-supplied and never trusted as authorization on its own —
 * WorkspaceMembershipGuard requires a membership row in the target
 * workspace before `findById` runs. Creating a workspace auto-adds the
 * creator as 'owner' (Part 3), which satisfies this for their own
 * workspace immediately.
 */
@Controller('workspaces')
export class WorkspaceController {
  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly userService: UserService,
    private readonly membershipService: WorkspaceMembershipService,
  ) {}

  @Post()
  async create(
    @Body(new ZodValidationPipe(createWorkspaceSchema))
    body: CreateWorkspaceInput,
  ) {
    const clerkUserId = RequestContext.get()?.userId;
    if (!clerkUserId) {
      throw new UnauthenticatedError('A bearer token is required.');
    }

    const workspace = await this.workspaceService.create(body.name);
    const user = await this.userService.findOrCreateByClerkId(clerkUserId);
    await this.membershipService.addMember(workspace.id, user.id, 'owner');

    return workspace;
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceMembershipGuard)
  async findById(@Param('workspaceId') workspaceId: string) {
    const workspace = await this.workspaceService.findById(workspaceId);
    if (!workspace) {
      throw new NotFoundError('Workspace not found.');
    }

    return workspace;
  }

  /** Doc 28 Phase 1 Permission Matrix — "Critical workspace settings": Owner Full, Admin Limited, no one else. */
  @Patch(':workspaceId')
  @UseGuards(WorkspaceMembershipGuard)
  @RequireWorkspaceRole('owner', 'admin')
  async rename(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(updateWorkspaceSchema))
    body: UpdateWorkspaceInput,
  ) {
    const workspace = await this.workspaceService.rename(workspaceId, body.name);
    if (!workspace) {
      throw new NotFoundError('Workspace not found.');
    }

    return workspace;
  }
}
