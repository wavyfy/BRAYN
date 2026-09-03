import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { CustomerIntelligenceService } from './customer-intelligence.service';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home): any
 * workspace member can view a customer record (doc 28 Phase 1 Permission
 * Matrix has no elevated-role requirement for customer viewing).
 */
@Controller('workspaces/:workspaceId/customers')
@UseGuards(WorkspaceMembershipGuard)
export class CustomerIntelligenceController {
  constructor(private readonly customerIntelligenceService: CustomerIntelligenceService) {}

  @Get()
  async list(
    @Param('workspaceId') workspaceId: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.customerIntelligenceService.listCustomers(workspaceId, {
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get(':canonicalCustomerId')
  async get(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.customerIntelligenceService.getCustomer(workspaceId, canonicalCustomerId);
  }

  @Get(':canonicalCustomerId/activity')
  async getActivity(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.customerIntelligenceService.getActivity(workspaceId, canonicalCustomerId);
  }
}
