import { describe, expect, it, vi } from 'vitest';
import { buildActionRegistry, RECOMMENDATION_COMPLETE_ACTION, RECOMMENDATION_DISMISS_ACTION } from './actions.registry';
import { RecommendationService } from '../intelligence-engines/recommendation.service';

const WORKSPACE_ID = 'ws_1';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const RECOMMENDATION_ID = '22222222-2222-4222-8222-222222222222';

function makeRecommendationService(overrides: Partial<RecommendationService> = {}): RecommendationService {
  return {
    dismiss: vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' })),
    complete: vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'completed' })),
    ...overrides,
  } as unknown as RecommendationService;
}

describe('buildActionRegistry', () => {
  it('registers dismiss/complete as low risk, no approval required', () => {
    const { dismiss, complete } = buildActionRegistry(makeRecommendationService());

    expect(dismiss.name).toBe(RECOMMENDATION_DISMISS_ACTION);
    expect(dismiss.riskLevel).toBe('low');
    expect(dismiss.requiresApproval).toBe(false);
    expect(complete.name).toBe(RECOMMENDATION_COMPLETE_ACTION);
    expect(complete.riskLevel).toBe('low');
    expect(complete.requiresApproval).toBe(false);
  });

  it('mirrors doc28\'s "AI action execution" row — owner/admin/marketing/support, not analyst', () => {
    const { dismiss, complete } = buildActionRegistry(makeRecommendationService());

    expect([...dismiss.allowedRoles].sort()).toEqual(['admin', 'marketing', 'owner', 'support']);
    expect([...complete.allowedRoles].sort()).toEqual(['admin', 'marketing', 'owner', 'support']);
  });

  it('dismiss.execute calls RecommendationService.dismiss with the context workspaceId/customerId, not anything from input', async () => {
    const recommendationService = makeRecommendationService();
    const { dismiss } = buildActionRegistry(recommendationService);

    await dismiss.execute(
      { recommendationId: RECOMMENDATION_ID, reason: 'no longer relevant' },
      { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID },
    );

    expect(recommendationService.dismiss).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID, RECOMMENDATION_ID, 'no longer relevant');
  });

  it('complete.execute calls RecommendationService.complete with the context workspaceId/customerId', async () => {
    const recommendationService = makeRecommendationService();
    const { complete } = buildActionRegistry(recommendationService);

    await complete.execute({ recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID });

    expect(recommendationService.complete).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID, RECOMMENDATION_ID);
  });

  it('dismiss input schema rejects a non-uuid recommendationId', () => {
    const { dismiss } = buildActionRegistry(makeRecommendationService());

    expect(dismiss.inputSchema.safeParse({ recommendationId: 'not-a-uuid' }).success).toBe(false);
  });

  it('complete input schema requires recommendationId', () => {
    const { complete } = buildActionRegistry(makeRecommendationService());

    expect(complete.inputSchema.safeParse({}).success).toBe(false);
  });

  it('summarizes the result without leaking recommendation text', () => {
    const { dismiss } = buildActionRegistry(makeRecommendationService());

    const summary = dismiss.summarizeResult?.({ id: RECOMMENDATION_ID, state: 'dismissed', text: 'internal margin secret' } as never);

    expect(summary).toEqual({ recommendationId: RECOMMENDATION_ID, state: 'dismissed' });
  });
});
