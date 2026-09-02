import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { IdentityResolutionService } from './identity-resolution.service';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home): any
 * workspace member can view flagged duplicates (doc09 "Detection" — a
 * read-only review surface; no merge/dismiss action exists yet, so no
 * elevated role is required to view).
 */
@Controller('workspaces/:workspaceId/identity/duplicates')
@UseGuards(WorkspaceMembershipGuard)
export class IdentityResolutionController {
  constructor(private readonly identityResolutionService: IdentityResolutionService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    return this.identityResolutionService.listDuplicates(workspaceId);
  }
}
