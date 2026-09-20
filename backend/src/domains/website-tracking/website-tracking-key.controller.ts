import { Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { WebsiteTrackingKeyService } from './website-tracking-key.service';

/**
 * Generates/rotates the write key a merchant copies into their storefront
 * tracking snippet (see `WebsiteTrackingKeyService`'s doc comment).
 * Owner/admin only, same tier as `IntegrationController`'s credentials
 * endpoint (doc28 Phase 1 Permission Matrix — "Integrations": Owner/Admin
 * Manage) — this key gates write access to the workspace's website
 * event stream, the same sensitivity class as a provider credential.
 *
 * Rotation is destructive by nature (the previous key stops working the
 * instant a new one is generated) — deliberately a POST that always
 * mints a fresh key rather than a GET that could leak an existing one
 * to anyone who can merely view the page.
 */
@Controller('workspaces/:workspaceId/website-tracking/write-key')
@UseGuards(WorkspaceMembershipGuard)
@RequireWorkspaceRole('owner', 'admin')
export class WebsiteTrackingKeyController {
  constructor(private readonly websiteTrackingKeyService: WebsiteTrackingKeyService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async generate(@Param('workspaceId') workspaceId: string) {
    return this.websiteTrackingKeyService.generate(workspaceId);
  }
}
