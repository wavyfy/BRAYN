import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RevenueOpportunityService } from './revenue-opportunity.service';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home): any
 * workspace member can view or trigger detection.
 */
@Controller('workspaces/:workspaceId/customers/:canonicalCustomerId/opportunities')
@UseGuards(WorkspaceMembershipGuard)
export class RevenueOpportunityController {
  constructor(private readonly revenueOpportunityService: RevenueOpportunityService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.revenueOpportunityService.list(workspaceId, canonicalCustomerId);
  }

  /** On-demand detection — same reasoning as CustomerHealthController.recalculate for why this isn't event-driven/scheduled yet. */
  @Post('detect')
  @HttpCode(HttpStatus.OK)
  async detect(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.revenueOpportunityService.detect(workspaceId, canonicalCustomerId);
  }
}
