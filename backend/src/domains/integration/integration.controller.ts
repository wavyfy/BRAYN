import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { IntegrationService } from './integration.service';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { connectIntegrationSchema, type ConnectIntegrationInput } from './dto/connect-integration.schema';

/**
 * Reuses the workspace domain's authorization boundary rather than
 * duplicating it (doc 03 rule 9 — business logic has one home): the
 * caller must be a member of `:workspaceId` to see its integrations, and
 * owner/admin to connect/disconnect one (doc 28 Phase 1 Permission
 * Matrix — "Integrations": Owner/Admin Manage, others View).
 */
@Controller('workspaces/:workspaceId/integrations')
@UseGuards(WorkspaceMembershipGuard)
export class IntegrationController {
  constructor(private readonly integrationService: IntegrationService) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    return this.integrationService.listByWorkspace(workspaceId);
  }

  @Post()
  @RequireWorkspaceRole('owner', 'admin')
  async connect(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(connectIntegrationSchema))
    body: ConnectIntegrationInput,
  ) {
    return this.integrationService.connect(workspaceId, body.provider);
  }

  @Delete(':provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireWorkspaceRole('owner', 'admin')
  async disconnect(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: ConnectIntegrationInput['provider'],
  ) {
    await this.integrationService.disconnect(workspaceId, provider);
  }
}
