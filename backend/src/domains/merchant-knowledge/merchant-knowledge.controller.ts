import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { MerchantKnowledgeService } from './merchant-knowledge.service';
import { createEntrySchema, type CreateEntryInput } from './dto/create-entry.schema';
import { updateEntrySchema, type UpdateEntryInput } from './dto/update-entry.schema';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9): doc28 Phase 1 Permission Matrix —
 * "Merchant Knowledge & Policies": Owner/Admin Manage, everyone else Read.
 */
@Controller('workspaces/:workspaceId/knowledge')
@UseGuards(WorkspaceMembershipGuard)
export class MerchantKnowledgeController {
  constructor(private readonly merchantKnowledgeService: MerchantKnowledgeService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string, @Query('type') type?: 'knowledge' | 'policy') {
    return this.merchantKnowledgeService.list(workspaceId, type);
  }

  @Post()
  @RequireWorkspaceRole('owner', 'admin')
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(createEntrySchema)) body: CreateEntryInput,
  ) {
    return this.merchantKnowledgeService.create(workspaceId, body);
  }

  @Get(':entryId')
  async get(@Param('workspaceId') workspaceId: string, @Param('entryId') entryId: string) {
    return this.merchantKnowledgeService.get(workspaceId, entryId);
  }

  @Patch(':entryId')
  @RequireWorkspaceRole('owner', 'admin')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('entryId') entryId: string,
    @Body(new ZodValidationPipe(updateEntrySchema)) body: UpdateEntryInput,
  ) {
    return this.merchantKnowledgeService.update(workspaceId, entryId, body);
  }

  @Get(':entryId/history')
  async getHistory(@Param('workspaceId') workspaceId: string, @Param('entryId') entryId: string) {
    return this.merchantKnowledgeService.getHistory(workspaceId, entryId);
  }
}
