import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { IntegrationService } from './integration.service';
import { IntegrationHealthService } from './integration-health.service';
import { ImportRunService } from './import-run.service';
import { WebhookIngestService } from './webhook-ingest.service';
import { ReconciliationRunService } from './reconciliation-run.service';
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
    private readonly webhookIngestService: WebhookIngestService,
    private readonly reconciliationRunService: ReconciliationRunService,
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

  /** Starts a background incremental sync (doc 06/20 — Incremental Synchronization); poll via GET /integrations (status/lastSyncedAt/lastSyncError). */
  @Post(':provider/sync')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireWorkspaceRole('owner', 'admin')
  async startSync(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: ConnectIntegrationInput['provider'],
  ) {
    return this.integrationService.startIncrementalSync(workspaceId, provider);
  }

  /** Starts a manual reconciliation pass (doc 06/19 — Reconciliation); returns the run so the caller can poll it (doc 23 — Async Operations). */
  @Post(':provider/reconcile')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireWorkspaceRole('owner', 'admin')
  async startReconciliation(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: ConnectIntegrationInput['provider'],
  ) {
    return this.integrationService.startReconciliation(workspaceId, provider);
  }

  /** Most recent reconciliation run for a provider, if any — drift-repair progress/completion visibility. */
  @Get(':provider/reconcile')
  async getLatestReconciliation(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: ConnectIntegrationInput['provider'],
  ) {
    return this.reconciliationRunService.getLatestReconciliationRun(workspaceId, provider);
  }

  /** Manually re-processes a dead-lettered webhook delivery (doc 21 — "Manual recovery where required"). */
  @Post(':provider/webhooks/:webhookEventId/replay')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequireWorkspaceRole('owner', 'admin')
  async replayWebhook(@Param('workspaceId') workspaceId: string, @Param('webhookEventId') webhookEventId: string) {
    return this.webhookIngestService.replay(workspaceId, webhookEventId);
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

  /** Manual/on-demand purge of a disconnected integration's customer data once its retention period has elapsed (doc18 — data minimization). */
  @Delete(':provider/customer-data')
  @RequireWorkspaceRole('owner', 'admin')
  async purgeCustomerData(
    @Param('workspaceId') workspaceId: string,
    @Param('provider') provider: ConnectIntegrationInput['provider'],
  ) {
    return this.integrationService.purgeCustomerData(workspaceId, provider);
  }
}
