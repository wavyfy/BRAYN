import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../../../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../../../workspace/require-workspace-role.decorator';
import { FlexyPeWebhookSetupService } from './flexype-webhook-setup.service';

/** Owner/admin only (doc28 Integrations: Owner/Admin Manage). Generating is a POST that always mints a fresh secret. */
@Controller('workspaces/:workspaceId/integrations/flexype/webhook-setup')
@UseGuards(WorkspaceMembershipGuard)
@RequireWorkspaceRole('owner', 'admin')
export class FlexyPeWebhookSetupController {
  constructor(private readonly setupService: FlexyPeWebhookSetupService) {}

  @Get()
  async getSettings(@Param('workspaceId') workspaceId: string) {
    return this.setupService.getSettings(workspaceId);
  }

  @Post('secret')
  @HttpCode(HttpStatus.OK)
  async generateSecret(@Param('workspaceId') workspaceId: string) {
    return this.setupService.generateSecret(workspaceId);
  }
}
