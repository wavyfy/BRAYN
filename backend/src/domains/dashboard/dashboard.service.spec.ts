import { describe, expect, it, vi } from 'vitest';
import { DashboardService } from './dashboard.service';
import type { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import type { RevenueOpportunityService } from '../intelligence-engines/revenue-opportunity.service';
import type { RecommendationService } from '../intelligence-engines/recommendation.service';
import type { IntegrationService } from '../integration/integration.service';

describe('DashboardService', () => {
  describe('getSummary()', () => {
    it('composes counts from each engine into one summary, without re-querying their tables', async () => {
      const customerIntelligenceService = {
        getWorkspaceSummary: vi.fn(async () => ({ customersCount: 5, ordersCount: 12, totalSpent: '450.00' })),
      } as unknown as CustomerIntelligenceService;
      const revenueOpportunityService = {
        countOpenByWorkspace: vi.fn(async () => ({ total: 4, byPriority: { critical: 0, high: 3, medium: 0, low: 1 } })),
      } as unknown as RevenueOpportunityService;
      const recommendationService = {
        countActiveByWorkspace: vi.fn(async () => 2),
      } as unknown as RecommendationService;
      const integrationService = {
        listByWorkspace: vi.fn(async () => [
          { provider: 'shopify', status: 'connected', lastSyncedAt: new Date('2026-01-01T00:00:00Z'), credentials: 'secret' },
        ]),
      } as unknown as IntegrationService;

      const service = new DashboardService(customerIntelligenceService, revenueOpportunityService, recommendationService, integrationService);

      const result = await service.getSummary('ws_1');

      expect(result).toEqual({
        customersCount: 5,
        commerce: { ordersCount: 12, totalSpent: '450.00' },
        openOpportunities: { total: 4, byPriority: { critical: 0, high: 3, medium: 0, low: 1 } },
        activeRecommendationsCount: 2,
        integrations: [{ provider: 'shopify', status: 'connected', lastSyncedAt: new Date('2026-01-01T00:00:00Z') }],
      });
      expect(customerIntelligenceService.getWorkspaceSummary).toHaveBeenCalledWith('ws_1');
    });
  });
});
