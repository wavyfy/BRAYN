import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { IntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';
import { ProviderRegistry } from './provider-registry.service';

/**
 * Owns: external connections, provider auth, imports, sync, webhook intake,
 * normalization, reconciliation, integration health.
 * See: "06. BRAYN Integration & Ingestion"
 *
 * Phase 3: integration model, connection lifecycle (list/connect/
 * disconnect), credential handling, and provider abstraction
 * (ProviderRegistry — empty until Phase 4 registers real adapters).
 * Imports WorkspaceModule for WorkspaceMembershipGuard rather than
 * duplicating the tenant-isolation/authorization boundary.
 */
@Module({
  imports: [WorkspaceModule],
  controllers: [IntegrationController],
  providers: [IntegrationService, ProviderRegistry],
  exports: [IntegrationService, ProviderRegistry],
})
export class IntegrationModule {}
