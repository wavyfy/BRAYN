import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { IntegrationController } from './integration.controller';
import { IntegrationService } from './integration.service';

/**
 * Owns: external connections, provider auth, imports, sync, webhook intake,
 * normalization, reconciliation, integration health.
 * See: "06. BRAYN Integration & Ingestion"
 *
 * Phase 3 part 1: integration model + connection lifecycle (list/connect/
 * disconnect). Imports WorkspaceModule for WorkspaceMembershipGuard rather
 * than duplicating the tenant-isolation/authorization boundary.
 */
@Module({
  imports: [WorkspaceModule],
  controllers: [IntegrationController],
  providers: [IntegrationService],
  exports: [IntegrationService],
})
export class IntegrationModule {}
