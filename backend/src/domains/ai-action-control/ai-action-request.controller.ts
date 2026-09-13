import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { AiActionControlService } from './ai-action-control.service';

/**
 * Doc28 Permission Matrix — "Audit records: Owner Full, Admin View, others
 * none" is the existing precedent for who may read an audit trail; applied
 * here unchanged rather than inventing a new rule for this new table.
 *
 * The same `owner`/`admin` gate also covers approve/deny below — doc28's
 * separate "AI action approval" row is Owner/Admin: Yes, Marketing/Support:
 * policy-dependent (no policy engine exists yet, doc13), Analyst: none —
 * so Owner/Admin-only is the correct Phase 1 scope, not a reuse shortcut.
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

  @Post(':id/approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  async approve(@Param('workspaceId') workspaceId: string, @Param('id') id: string): Promise<void> {
    await this.aiActionControl.approve(id, { workspaceId });
  }

  @Post(':id/deny')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deny(@Param('workspaceId') workspaceId: string, @Param('id') id: string): Promise<void> {
    await this.aiActionControl.deny(id, { workspaceId });
  }
}
