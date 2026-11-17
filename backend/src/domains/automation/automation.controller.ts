import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { AutomationService } from './automation.service';
import { createAutomationSchema, type CreateAutomationInput } from './dto/create-automation.schema';
import { updateAutomationSchema, type UpdateAutomationInput } from './dto/update-automation.schema';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9): doc28 Phase 1 Permission Matrix —
 * "Business Action Automation": Owner Full, Admin/Marketing Manage,
 * Analyst View, Support has no access at all.
 */
@Controller('workspaces/:workspaceId/automations')
@UseGuards(WorkspaceMembershipGuard)
export class AutomationController {
  constructor(private readonly automationService: AutomationService) {}

  @Get()
  @RequireWorkspaceRole('owner', 'admin', 'marketing', 'analyst')
  async list(@Param('workspaceId') workspaceId: string) {
    return this.automationService.list(workspaceId);
  }

  @Get(':automationId')
  @RequireWorkspaceRole('owner', 'admin', 'marketing', 'analyst')
  async get(@Param('workspaceId') workspaceId: string, @Param('automationId') automationId: string) {
    return this.automationService.get(workspaceId, automationId);
  }

  @Post()
  @RequireWorkspaceRole('owner', 'admin', 'marketing')
  async create(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(createAutomationSchema)) body: CreateAutomationInput,
  ) {
    return this.automationService.create(workspaceId, body);
  }

  @Patch(':automationId')
  @RequireWorkspaceRole('owner', 'admin', 'marketing')
  async update(
    @Param('workspaceId') workspaceId: string,
    @Param('automationId') automationId: string,
    @Body(new ZodValidationPipe(updateAutomationSchema)) body: UpdateAutomationInput,
  ) {
    return this.automationService.update(workspaceId, automationId, body);
  }

  @Get(':automationId/runs')
  @RequireWorkspaceRole('owner', 'admin', 'marketing', 'analyst')
  async listRuns(@Param('workspaceId') workspaceId: string, @Param('automationId') automationId: string) {
    return this.automationService.listRuns(workspaceId, automationId);
  }

  /** Manual retry of a failed run (doc16 decision, Nov 2, 2026) — same roles that manage automations (doc28). Returns the new run. */
  @Post(':automationId/runs/:runId/retry')
  @RequireWorkspaceRole('owner', 'admin', 'marketing')
  async retryRun(
    @Param('workspaceId') workspaceId: string,
    @Param('automationId', new ParseUUIDPipe()) automationId: string,
    @Param('runId', new ParseUUIDPipe()) runId: string,
  ) {
    return this.automationService.retryRun(workspaceId, automationId, runId);
  }
}
