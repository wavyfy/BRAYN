import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { LogsProtectedAccess } from '../../common/access-log/protected-data-access.decorator';
import { ValidationError } from '../../common/errors/app-error';
import { IdentityResolutionService } from './identity-resolution.service';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home).
 *
 * Owner/admin only — `matchedValue` on each flagged pair is the matched
 * phone number or email itself (doc09 "Detection"), so this is customer
 * PII the same as the customer profile endpoints, not just an internal
 * review queue; reviewing a candidate is likewise owner/admin only.
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

  @Post(':duplicateId/dismiss')
  @HttpCode(HttpStatus.OK)
  @LogsProtectedAccess('identity_duplicate', 'duplicateId')
  async dismiss(@Param('workspaceId') workspaceId: string, @Param('duplicateId') duplicateId: string) {
    return this.identityResolutionService.dismiss(workspaceId, duplicateId);
  }

  /** Manual, owner/admin-approved merge of a pending candidate — see `IdentityResolutionService.merge()`. */
  @Post(':duplicateId/merge')
  @HttpCode(HttpStatus.OK)
  @LogsProtectedAccess('identity_duplicate', 'duplicateId')
  async merge(@Param('workspaceId') workspaceId: string, @Param('duplicateId') duplicateId: string, @Body('reason') reason?: unknown) {
    if (reason !== undefined && reason !== null && typeof reason !== 'string') {
      throw new ValidationError('Reason must be a string.');
    }
    return this.identityResolutionService.merge(workspaceId, duplicateId, reason ?? undefined);
  }
}
