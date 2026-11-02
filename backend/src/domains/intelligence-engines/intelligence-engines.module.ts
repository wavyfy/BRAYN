import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { CustomerIntelligenceModule } from '../customer-intelligence/customer-intelligence.module';
import { CustomerHealthService } from './customer-health.service';
import { CustomerHealthController } from './customer-health.controller';
import { RevenueOpportunityService } from './revenue-opportunity.service';
import { RevenueOpportunityController } from './revenue-opportunity.controller';
import { RecommendationService } from './recommendation.service';
import { RecommendationController } from './recommendation.controller';
import { IntelligenceDailyRunService } from './intelligence-daily-run.service';
import { IntelligenceDailyRunController } from './intelligence-daily-run.controller';
import { InternalNotificationService } from './internal-notification.service';
import { InternalNotificationController } from './internal-notification.controller';
import { InternalCronGuard } from '../../common/auth/internal-cron.guard';

/**
 * Owns derived customer intelligence: Customer Risk & Engagement State,
 * Revenue Opportunity Detector, recommendations, signals, prioritization.
 * See: "10. BRAYN Customer Intelligence Engines"
 *
 * Phase 1: Customer Risk & Engagement State, signals-only (recency +
 * frequency) — see CustomerHealthService's doc comment for why the
 * overall score/category stay withheld. Revenue Opportunity Detector:
 * commerce-only opportunity types (reorder/win_back/vip_recognition) —
 * see RevenueOpportunityService's doc comment for the rest. Recommendations:
 * generated 1:1 from open Revenue Opportunities — see recommendations
 * schema's doc comment for why the other doc10 inputs aren't available yet.
 * Internal notifications: one per opportunity, created only by the
 * automation action `internal_notification.create` (InternalNotificationService).
 * Daily run: IntelligenceDailyRunService, called by the external scheduler
 * through the internal endpoint (Milestone #5 D2).
 *
 * Imports CustomerIntelligenceModule to consume UCIR rather than
 * re-querying Commerce tables itself (doc04 Rule 2). Imports
 * WorkspaceModule for WorkspaceMembershipGuard rather than duplicating
 * the tenant-isolation/authorization boundary.
 */
@Module({
  imports: [WorkspaceModule, CustomerIntelligenceModule],
  controllers: [CustomerHealthController, RevenueOpportunityController, RecommendationController, IntelligenceDailyRunController, InternalNotificationController],
  providers: [CustomerHealthService, RevenueOpportunityService, RecommendationService, IntelligenceDailyRunService, InternalNotificationService, InternalCronGuard],
  exports: [CustomerHealthService, RevenueOpportunityService, RecommendationService, InternalNotificationService],
})
export class IntelligenceEnginesModule {}
