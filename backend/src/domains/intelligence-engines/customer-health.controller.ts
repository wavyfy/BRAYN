import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { CustomerHealthService } from './customer-health.service';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home): any
 * workspace member can view or trigger a recalculation (doc10 — "Manual
 * health overrides not supported" means no one can *set* a score, but
 * triggering the deterministic calculation isn't an override).
 */
@Controller('workspaces/:workspaceId/customers/:canonicalCustomerId/health')
@UseGuards(WorkspaceMembershipGuard)
export class CustomerHealthController {
  constructor(private readonly customerHealthService: CustomerHealthService) {}

  @Get()
  async get(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.customerHealthService.getCurrent(workspaceId, canonicalCustomerId);
  }

  /** On-demand recalculation — see CustomerHealthService's doc comment for why this isn't event-driven/scheduled yet. */
  @Post('recalculate')
  @HttpCode(HttpStatus.OK)
  async recalculate(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.customerHealthService.recalculate(workspaceId, canonicalCustomerId);
  }
}
