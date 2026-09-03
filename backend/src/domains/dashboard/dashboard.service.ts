import { Injectable } from '@nestjs/common';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { RevenueOpportunityService } from '../intelligence-engines/revenue-opportunity.service';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import { IntegrationService } from '../integration/integration.service';

/**
 * Merchant Dashboard (doc11 — "aggregated merchant intelligence"). Pure
 * composition over existing domain services rather than re-querying their
 * tables (doc04 Rule 2 — "Consume, Don't Duplicate"): this service owns no
 * data of its own.
 *
 * Phase 1 scope: the doc11 dashboard areas that are actually computable
 * today — customer count, commerce activity, open revenue opportunities,
 * active recommendations, integration status. Not included: Customer Risk
 * & Engagement State trends (health score itself is withheld — see
 * CustomerHealthService), AI insights (doc19 Phase 11 not built), and any
 * time-series "trend" (no historical-snapshot aggregation exists yet —
 * not scoped ahead of need, doc18).
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly customerIntelligenceService: CustomerIntelligenceService,
    private readonly revenueOpportunityService: RevenueOpportunityService,
    private readonly recommendationService: RecommendationService,
    private readonly integrationService: IntegrationService,
  ) {}

  async getSummary(workspaceId: string) {
    const [commerce, openOpportunities, activeRecommendationsCount, integrations] = await Promise.all([
      this.customerIntelligenceService.getWorkspaceSummary(workspaceId),
      this.revenueOpportunityService.countOpenByWorkspace(workspaceId),
      this.recommendationService.countActiveByWorkspace(workspaceId),
      this.integrationService.listByWorkspace(workspaceId),
    ]);

    return {
      customersCount: commerce.customersCount,
      commerce: { ordersCount: commerce.ordersCount, totalSpent: commerce.totalSpent },
      openOpportunities,
      activeRecommendationsCount,
      integrations: integrations.map((integration) => ({
        provider: integration.provider,
        status: integration.status,
        lastSyncedAt: integration.lastSyncedAt,
      })),
    };
  }
}
