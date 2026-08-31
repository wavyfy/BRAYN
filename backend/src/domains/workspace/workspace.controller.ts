import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { NotFoundError, UnauthenticatedError, UnauthorizedError } from '../../common/errors/app-error';
import { RequestContext } from '../../common/logging/request-context';
import { WorkspaceService } from './workspace.service';
import { UserService } from './user.service';
import { WorkspaceMembershipService } from './workspace-membership.service';
import { createWorkspaceSchema, type CreateWorkspaceInput } from './dto/create-workspace.schema';

/**
 * Protected by the global AuthGuard by default (Step 6) — no @Public().
 * Tenant-isolated (doc 28 — Tenant Isolation): `id` in the URL is
 * client-supplied and never trusted as authorization on its own — the
 * caller must have a membership row in the target workspace to read it.
 * Creating a workspace auto-adds the creator as 'owner' (Part 3), which
 * satisfies this for their own workspace immediately.
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

  @Get(':id')
  async findById(@Param('id') id: string) {
    const clerkUserId = RequestContext.get()?.userId;
    if (!clerkUserId) {
      throw new UnauthenticatedError('A bearer token is required.');
    }

    const caller = await this.userService.findOrCreateByClerkId(clerkUserId);
    const membership = await this.membershipService.findMembership(id, caller.id);
    if (!membership) {
      throw new UnauthorizedError('You are not a member of this workspace.');
    }

    const workspace = await this.workspaceService.findById(id);
    if (!workspace) {
      throw new NotFoundError('Workspace not found.');
    }

    return workspace;
  }
}
