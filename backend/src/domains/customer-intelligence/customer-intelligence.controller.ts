import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { LogsProtectedAccess } from '../../common/access-log/protected-data-access.decorator';
import { CustomerIntelligenceService } from './customer-intelligence.service';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home).
 *
 * Owner/admin only — every method here returns customer-identifying
 * personal data (email/phone/name, or order/activity tied to a specific
 * customer). Class-level `@RequireWorkspaceRole` applies to all three
 * handlers (`WorkspaceMembershipGuard` checks the handler first, then
 * falls back to the class), so it's declared once rather than repeated.
 */
@Controller('workspaces/:workspaceId/customers')
@UseGuards(WorkspaceMembershipGuard)
@RequireWorkspaceRole('owner', 'admin')
export class CustomerIntelligenceController {
  constructor(private readonly customerIntelligenceService: CustomerIntelligenceService) {}

  @Get()
  @LogsProtectedAccess('customer')
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
  @LogsProtectedAccess('customer', 'canonicalCustomerId')
  async get(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.customerIntelligenceService.getCustomer(workspaceId, canonicalCustomerId);
  }

  @Get(':canonicalCustomerId/activity')
  @LogsProtectedAccess('customer_activity', 'canonicalCustomerId')
  async getActivity(@Param('workspaceId') workspaceId: string, @Param('canonicalCustomerId') canonicalCustomerId: string) {
    return this.customerIntelligenceService.getActivity(workspaceId, canonicalCustomerId);
  }
}
