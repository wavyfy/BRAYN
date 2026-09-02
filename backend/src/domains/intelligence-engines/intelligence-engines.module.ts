import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { CustomerIntelligenceModule } from '../customer-intelligence/customer-intelligence.module';
import { CustomerHealthService } from './customer-health.service';
import { CustomerHealthController } from './customer-health.controller';
import { RevenueOpportunityService } from './revenue-opportunity.service';
import { RevenueOpportunityController } from './revenue-opportunity.controller';

/**
 * Owns derived customer intelligence: Customer Risk & Engagement State,
 * Revenue Opportunity Detector, recommendations, signals, prioritization.
 * See: "10. BRAYN Customer Intelligence Engines"
 *
 * Phase 1: Customer Risk & Engagement State, signals-only (recency +
 * frequency) — see CustomerHealthService's doc comment for why the
 * overall score/category stay withheld. Revenue Opportunity Detector:
 * commerce-only opportunity types (reorder/win_back/vip_recognition) —
 * see RevenueOpportunityService's doc comment for the rest. Recommendations
 * is a later part.
 *
 * Imports CustomerIntelligenceModule to consume UCIR rather than
 * re-querying Commerce tables itself (doc04 Rule 2). Imports
 * WorkspaceModule for WorkspaceMembershipGuard rather than duplicating
 * the tenant-isolation/authorization boundary.
 */
@Module({
  imports: [WorkspaceModule, CustomerIntelligenceModule],
  controllers: [CustomerHealthController, RevenueOpportunityController],
  providers: [CustomerHealthService, RevenueOpportunityService],
  exports: [CustomerHealthService, RevenueOpportunityService],
})
export class IntelligenceEnginesModule {}
