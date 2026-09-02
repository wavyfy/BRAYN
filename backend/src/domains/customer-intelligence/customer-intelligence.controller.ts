import { Controller, Get, Param, UseGuards } from '@nestjs/common';
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

  @Get(':canonicalCustomerId')
  async get(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.customerIntelligenceService.getCustomer(workspaceId, canonicalCustomerId);
  }
}
