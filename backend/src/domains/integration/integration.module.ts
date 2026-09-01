import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { IntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';
import { ProviderRegistry } from './provider-registry.service';
import { ImportRunService } from './import-run.service';
import { WebhookIngestService } from './webhook-ingest.service';
import { IntegrationHealthService } from './integration-health.service';
import { ReconciliationRunService } from './reconciliation-run.service';

/**
 * Owns: external connections, provider auth, imports, sync, webhook intake,
 * normalization, reconciliation, integration health.
 * See: "06. BRAYN Integration & Ingestion"
 *
 * Phase 3: integration model, connection lifecycle (list/connect/
 * disconnect), credential handling, provider abstraction (ProviderRegistry
 * — empty until Phase 4 registers real adapters), the import-run framework
 * (ImportRunService — bookkeeping only; a concrete provider drives actual
 * pagination/import in Phase 4), and the webhook framework
 * (WebhookIngestService — verify/dedupe/persist/emit, no HTTP route until
 * a registered adapter exists to verify real signatures), and integration
 * health (IntegrationHealthService — rolls up connection/sync/import
 * state into a merchant-facing status; exposed via GET .../health since
 * it only reads state this session's framework already tracks, no real
 * provider required), and the retry/reconciliation foundation
 * (ReconciliationRunService — bookkeeping only, same scope boundary as
 * ImportRunService; retry itself reuses the existing generic
 * common/async/retry.ts rather than a new mechanism). Imports
 * WorkspaceModule for WorkspaceMembershipGuard rather than duplicating
 * the tenant-isolation/authorization boundary.
 */
@Module({
  imports: [WorkspaceModule],
  controllers: [IntegrationController],
  providers: [
    IntegrationService,
    ProviderRegistry,
    ImportRunService,
    WebhookIngestService,
    IntegrationHealthService,
    ReconciliationRunService,
  ],
  exports: [
    IntegrationService,
    ProviderRegistry,
    ImportRunService,
    WebhookIngestService,
    IntegrationHealthService,
    ReconciliationRunService,
  ],
})
export class IntegrationModule {}
