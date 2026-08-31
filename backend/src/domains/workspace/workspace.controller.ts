import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { NotFoundError } from '../../common/errors/app-error';
import { WorkspaceService } from './workspace.service';
import { createWorkspaceSchema, type CreateWorkspaceInput } from './dto/create-workspace.schema';

/**
 * Protected by the global AuthGuard by default (Step 6) — no @Public().
 * Not yet workspace-membership-scoped: that requires Users + Roles
 * (later Phase 2 parts), so any authenticated caller can create/read a
 * workspace today. Tightened once membership exists.
 */
@Controller('workspaces')
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Post()
  async create(
    @Body(new ZodValidationPipe(createWorkspaceSchema))
    body: CreateWorkspaceInput,
  ) {
    return this.workspaceService.create(body.name);
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    const workspace = await this.workspaceService.findById(id);

    if (!workspace) {
      throw new NotFoundError('Workspace not found.');
    }

    return workspace;
  }
}
