import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { LogsProtectedAccess } from '../../common/access-log/protected-data-access.decorator';
import { IdentityResolutionService } from './identity-resolution.service';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home).
 *
 * Owner/admin only — `matchedValue` on each flagged pair is the raw
 * matched phone number itself (doc09 "Detection"), so this is customer
 * PII the same as the customer profile endpoints, not just an internal
 * review queue.
 */
@Controller('workspaces/:workspaceId/identity/duplicates')
@UseGuards(WorkspaceMembershipGuard)
@RequireWorkspaceRole('owner', 'admin')
export class IdentityResolutionController {
  constructor(private readonly identityResolutionService: IdentityResolutionService) {}

  @Get()
  @LogsProtectedAccess('identity_duplicate')
  async list(@Param('workspaceId') workspaceId: string) {
    return this.identityResolutionService.listDuplicates(workspaceId);
  }
}
