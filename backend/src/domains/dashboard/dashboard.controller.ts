import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { DashboardService } from './dashboard.service';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home): any
 * workspace member can view the dashboard.
 */
@Controller('workspaces/:workspaceId/dashboard')
@UseGuards(WorkspaceMembershipGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  async get(@Param('workspaceId') workspaceId: string) {
    return this.dashboardService.getSummary(workspaceId);
  }
}
