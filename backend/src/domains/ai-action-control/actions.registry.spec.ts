import { describe, expect, it, vi } from 'vitest';
import { buildActionRegistry, RECOMMENDATION_COMPLETE_ACTION, RECOMMENDATION_DISMISS_ACTION } from './actions.registry';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import type { OrderService } from '../commerce/order.service';

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
    const { dismiss, complete } = buildActionRegistry(makeRecommendationService(), {} as OrderService);

    expect(dismiss.name).toBe(RECOMMENDATION_DISMISS_ACTION);
    expect(dismiss.riskLevel).toBe('low');
    expect(dismiss.requiresApproval).toBe(false);
    expect(complete.name).toBe(RECOMMENDATION_COMPLETE_ACTION);
    expect(complete.riskLevel).toBe('low');
    expect(complete.requiresApproval).toBe(false);
  });

  it('mirrors doc28\'s "AI action execution" row — owner/admin/marketing/support, not analyst', () => {
    const { dismiss, complete } = buildActionRegistry(makeRecommendationService(), {} as OrderService);

    expect([...dismiss.allowedRoles].sort()).toEqual(['admin', 'marketing', 'owner', 'support']);
    expect([...complete.allowedRoles].sort()).toEqual(['admin', 'marketing', 'owner', 'support']);
  });

  it('dismiss.execute calls RecommendationService.dismiss with the context workspaceId/customerId, not anything from input', async () => {
    const recommendationService = makeRecommendationService();
    const { dismiss } = buildActionRegistry(recommendationService, {} as OrderService);

    await dismiss.execute(
      { recommendationId: RECOMMENDATION_ID, reason: 'no longer relevant' },
      { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID },
    );

    expect(recommendationService.dismiss).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID, RECOMMENDATION_ID, 'no longer relevant');
  });

  it('complete.execute calls RecommendationService.complete with the context workspaceId/customerId', async () => {
    const recommendationService = makeRecommendationService();
    const { complete } = buildActionRegistry(recommendationService, {} as OrderService);

    await complete.execute({ recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID });

    expect(recommendationService.complete).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID, RECOMMENDATION_ID);
  });

  it('dismiss input schema rejects a non-uuid recommendationId', () => {
    const { dismiss } = buildActionRegistry(makeRecommendationService(), {} as OrderService);

    expect(dismiss.inputSchema.safeParse({ recommendationId: 'not-a-uuid' }).success).toBe(false);
  });

  it('complete input schema requires recommendationId', () => {
    const { complete } = buildActionRegistry(makeRecommendationService(), {} as OrderService);

    expect(complete.inputSchema.safeParse({}).success).toBe(false);
  });

  it('summarizes the result without leaking recommendation text', () => {
    const { dismiss } = buildActionRegistry(makeRecommendationService(), {} as OrderService);

    const summary = dismiss.summarizeResult?.({ id: RECOMMENDATION_ID, state: 'dismissed', text: 'internal margin secret' } as never);

    expect(summary).toEqual({ recommendationId: RECOMMENDATION_ID, state: 'dismissed' });
  });
});

describe('order.refund_request definition (#8 Decision A)', () => {
  const ORDER_ID = '33333333-3333-4333-8333-333333333333';
  const context = { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID };
  const makeOrderService = (result: { amount: string } | { reason: string }) =>
    ({ findRefundableAmount: vi.fn(async () => result) }) as unknown as OrderService;

  it('is high risk, always requires approval, and is owner/admin only', () => {
    const { refundRequest } = buildActionRegistry(makeRecommendationService(), makeOrderService({ amount: '1.00' }));
    expect(refundRequest).toMatchObject({ name: 'order.refund_request', riskLevel: 'high', requiresApproval: true, allowedRoles: ['owner', 'admin'] });
  });

  it('accepts only orderId + reason (≤500 chars); never an amount, workspace or customer', () => {
    const { refundRequest } = buildActionRegistry(makeRecommendationService(), makeOrderService({ amount: '1.00' }));
    expect(refundRequest.inputSchema.safeParse({ orderId: ORDER_ID, reason: 'x'.repeat(500) }).success).toBe(true);
    expect(refundRequest.inputSchema.safeParse({ orderId: ORDER_ID, reason: 'x'.repeat(501) }).success).toBe(false);
    expect(refundRequest.inputSchema.safeParse({ orderId: ORDER_ID, reason: '' }).success).toBe(false);
    expect(refundRequest.inputSchema.safeParse({ orderId: 'not-a-uuid', reason: 'x' }).success).toBe(false);
    const parsed = refundRequest.inputSchema.parse({ orderId: ORDER_ID, reason: 'x', amount: '999', workspaceId: 'ws_2', customerId: 'c' });
    expect(parsed).toEqual({ orderId: ORDER_ID, reason: 'x' });
  });

  it('validates against the context customer and scopes pending requests by order', async () => {
    const orderService = makeOrderService({ reason: 'The order is cancelled.' });
    const { refundRequest } = buildActionRegistry(makeRecommendationService(), orderService);
    expect(await refundRequest.validate!({ orderId: ORDER_ID, reason: 'x' }, context)).toBe('The order is cancelled.');
    expect(orderService.findRefundableAmount).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID, ORDER_ID);
    expect(refundRequest.pendingScope!({ orderId: ORDER_ID, reason: 'x' })).toEqual({ orderId: ORDER_ID });
  });

  it('executes as a simulation with the computed amount, and fails rather than simulate an invalid refund', async () => {
    const { refundRequest } = buildActionRegistry(makeRecommendationService(), makeOrderService({ amount: '24.50' }));
    const result = await refundRequest.execute({ orderId: ORDER_ID, reason: 'x' }, context);
    expect(result).toEqual({ mode: 'simulated', orderId: ORDER_ID, amount: '24.50' });
    expect(refundRequest.summarizeResult!(result)).toEqual({ mode: 'simulated', orderId: ORDER_ID, amount: '24.50' });

    const invalid = buildActionRegistry(makeRecommendationService(), makeOrderService({ reason: 'The order is cancelled.' })).refundRequest;
    await expect(invalid.execute({ orderId: ORDER_ID, reason: 'x' }, context)).rejects.toThrow('The order is cancelled.');
  });
});
