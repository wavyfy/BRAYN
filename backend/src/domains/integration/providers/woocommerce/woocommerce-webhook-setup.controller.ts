import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../../../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../../../workspace/require-workspace-role.decorator';
import { WooCommerceWebhookSetupService } from './woocommerce-webhook-setup.service';

/**
 * Owner/admin only — same tier as the credentials endpoint (doc28 "Integrations": Owner/Admin Manage); the secret
 * gates write access to the workspace's commerce data. Generating is a POST that always mints a fresh secret (and so
 * rotates it), never a GET that could reveal an existing one.
 */
@Controller('workspaces/:workspaceId/integrations/woocommerce/webhook-setup')
@UseGuards(WorkspaceMembershipGuard)
@RequireWorkspaceRole('owner', 'admin')
export class WooCommerceWebhookSetupController {
  constructor(private readonly setupService: WooCommerceWebhookSetupService) {}

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
