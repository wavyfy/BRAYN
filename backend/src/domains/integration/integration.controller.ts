import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { IntegrationService } from './integration.service';
import { IntegrationHealthService } from './integration-health.service';
import { ImportRunService } from './import-run.service';
import { WorkspaceMembershipGuard } from '../workspace/workspace-membership.guard';
import { RequireWorkspaceRole } from '../workspace/require-workspace-role.decorator';
import { connectIntegrationSchema, type ConnectIntegrationInput } from './dto/connect-integration.schema';
import { connectCredentialsSchema, type ConnectCredentialsInput } from './dto/connect-credentials.schema';

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
  constructor(
    private readonly integrationService: IntegrationService,
    private readonly integrationHealthService: IntegrationHealthService,
    private readonly importRunService: ImportRunService,
  ) {}

  @Get()
  async list(@Param('workspaceId') workspaceId: string) {
    return this.integrationService.listByWorkspace(workspaceId);
  }

  @Get(':provider/health')
  async health(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: ConnectIntegrationInput['provider'],
  ) {
    return this.integrationHealthService.getHealth(workspaceId, provider);
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

  /**
   * Verifies `credentials` against the provider before storing them
   * (IntegrationService.connectCredentials) — never returns them. The
   * request body shape is provider-agnostic; validate connect() was
   * called first via NotFoundError from the service.
   */
  @Post(':provider/credentials')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireWorkspaceRole('owner', 'admin')
  async connectCredentials(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: ConnectIntegrationInput['provider'],
    @Body(new ZodValidationPipe(connectCredentialsSchema))
    body: ConnectCredentialsInput,
  ) {
    await this.integrationService.connectCredentials(workspaceId, provider, body.credentials);
  }

  /** Starts a background initial import; returns the run so the caller can poll it (doc 23 — Async Operations). */
  @Post(':provider/import')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireWorkspaceRole('owner', 'admin')
  async startImport(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: ConnectIntegrationInput['provider'],
  ) {
    return this.integrationService.startInitialImport(workspaceId, provider);
  }

  /** Most recent import run for a provider — import progress/completion visibility (doc 19 Phase 4 Visible Result). */
  @Get(':provider/import')
  async getLatestImport(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: ConnectIntegrationInput['provider'],
  ) {
    return this.importRunService.getLatestImportRun(workspaceId, provider);
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
