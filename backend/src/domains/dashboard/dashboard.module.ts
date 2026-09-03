import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { CustomerIntelligenceModule } from '../customer-intelligence/customer-intelligence.module';
import { IntelligenceEnginesModule } from '../intelligence-engines/intelligence-engines.module';
import { IntegrationModule } from '../integration/integration.module';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';

/**
 * Owns merchant-facing dashboard aggregation (doc19 Phase 8 — "Dashboard
 * intelligence, Merchant-level views"; doc11 "Merchant Dashboard"). Pure
 * presentation composition — see DashboardService's doc comment; owns no
 * data of its own.
 *
 * Imports the domains it composes rather than re-implementing their
 * queries (doc04 Rule 2), and WorkspaceModule for WorkspaceMembershipGuard
 * rather than duplicating the tenant-isolation/authorization boundary.
 */
@Module({
  imports: [WorkspaceModule, CustomerIntelligenceModule, IntelligenceEnginesModule, IntegrationModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
