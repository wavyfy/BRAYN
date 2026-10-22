import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, UseGuards } from '@nestjs/common';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { WebsiteTrackingKeyService } from './website-tracking-key.service';
import { setAllowedOriginsSchema, type SetAllowedOriginsInput } from './dto/set-allowed-origins.schema';

/**
 * Website-tracking settings a merchant configures for their storefront
 * snippet (see `WebsiteTrackingKeyService`'s doc comment). Owner/admin
 * only, same tier as `IntegrationController`'s credentials endpoint
 * (doc28 Phase 1 Permission Matrix — "Integrations": Owner/Admin Manage)
 * — these gate write access to the workspace's website event stream and
 * its identity linking, the same sensitivity class as a provider credential.
 *
 * Rotation is destructive by nature (the previous key/secret stops
 * working the instant a new one is generated) — deliberately POSTs that
 * always mint a fresh value rather than GETs that could leak an existing
 * one to anyone who can merely view the page.
 */
@Controller('workspaces/:workspaceId/website-tracking')
@UseGuards(WorkspaceMembershipGuard)
@RequireWorkspaceRole('owner', 'admin')
export class WebsiteTrackingKeyController {
  constructor(private readonly websiteTrackingKeyService: WebsiteTrackingKeyService) {}

  @Get('settings')
  async getSettings(@Param('workspaceId') workspaceId: string) {
    return this.websiteTrackingKeyService.getSettings(workspaceId);
  }

  @Post('write-key')
  @HttpCode(HttpStatus.OK)
  async generate(@Param('workspaceId') workspaceId: string) {
    return this.websiteTrackingKeyService.generate(workspaceId);
  }

  @Post('identity-secret')
  @HttpCode(HttpStatus.OK)
  async generateIdentitySecret(@Param('workspaceId') workspaceId: string) {
    return this.websiteTrackingKeyService.generateIdentitySecret(workspaceId);
  }

  @Put('allowed-origins')
  async setAllowedOrigins(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(setAllowedOriginsSchema)) body: SetAllowedOriginsInput,
  ) {
    return this.websiteTrackingKeyService.setAllowedOrigins(workspaceId, body.origins);
  }
}
