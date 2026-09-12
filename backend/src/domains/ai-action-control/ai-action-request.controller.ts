import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { AiActionControlService } from './ai-action-control.service';

/**
 * Doc28 Permission Matrix — "Audit records: Owner Full, Admin View, others
 * none" is the existing precedent for who may read an audit trail; applied
 * here unchanged rather than inventing a new rule for this new table.
 */
@Controller('workspaces/:workspaceId/ai-actions')
@UseGuards(WorkspaceMembershipGuard)
@RequireWorkspaceRole('owner', 'admin')
export class AiActionRequestController {
  constructor(private readonly aiActionControl: AiActionControlService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    return this.aiActionControl.listRecent(workspaceId);
  }
}
