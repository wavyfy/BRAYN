import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RecommendationService } from './recommendation.service';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home): any
 * workspace member can view, generate, dismiss, or complete recommendations.
 */
@Controller('workspaces/:workspaceId/customers/:canonicalCustomerId/recommendations')
@UseGuards(WorkspaceMembershipGuard)
export class RecommendationController {
  constructor(private readonly recommendationService: RecommendationService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.recommendationService.list(workspaceId, canonicalCustomerId);
  }

  /** On-demand generation — same reasoning as the other engines for why this isn't event-driven/scheduled yet. */
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  async generate(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.recommendationService.generate(workspaceId, canonicalCustomerId);
  }

  @Post(':recommendationId/dismiss')
  @HttpCode(HttpStatus.OK)
  async dismiss(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Param('recommendationId') recommendationId: string,
    @Body('reason') reason?: string,
  ) {
    return this.recommendationService.dismiss(workspaceId, canonicalCustomerId, recommendationId, reason);
  }

  @Post(':recommendationId/complete')
  @HttpCode(HttpStatus.OK)
  async complete(
    @Param('workspaceId') workspaceId: string,
    @Param('canonicalCustomerId') canonicalCustomerId: string,
    @Param('recommendationId') recommendationId: string,
  ) {
    return this.recommendationService.complete(workspaceId, canonicalCustomerId, recommendationId);
  }
}
