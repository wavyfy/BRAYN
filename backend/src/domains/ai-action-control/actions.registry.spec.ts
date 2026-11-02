import { describe, expect, it, vi } from 'vitest';
import { buildActionRegistry, INTERNAL_NOTIFICATION_CREATE_ACTION, RECOMMENDATION_COMPLETE_ACTION, RECOMMENDATION_DISMISS_ACTION } from './actions.registry';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import type { OrderService } from '../commerce/order.service';
import type { InternalNotificationService } from '../intelligence-engines/internal-notification.service';

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
    const { dismiss, complete } = buildActionRegistry(makeRecommendationService(), {} as OrderService, {} as InternalNotificationService);

    expect(dismiss.name).toBe(RECOMMENDATION_DISMISS_ACTION);
    expect(dismiss.riskLevel).toBe('low');
    expect(dismiss.requiresApproval).toBe(false);
    expect(complete.name).toBe(RECOMMENDATION_COMPLETE_ACTION);
    expect(complete.riskLevel).toBe('low');
    expect(complete.requiresApproval).toBe(false);
  });

  it('mirrors doc28\'s "AI action execution" row — owner/admin/marketing/support, not analyst', () => {
    const { dismiss, complete } = buildActionRegistry(makeRecommendationService(), {} as OrderService, {} as InternalNotificationService);

    expect([...dismiss.allowedRoles].sort()).toEqual(['admin', 'marketing', 'owner', 'support']);
    expect([...complete.allowedRoles].sort()).toEqual(['admin', 'marketing', 'owner', 'support']);
  });

  it('dismiss.execute calls RecommendationService.dismiss with the context workspaceId/customerId, not anything from input', async () => {
    const recommendationService = makeRecommendationService();
    const { dismiss } = buildActionRegistry(recommendationService, {} as OrderService, {} as InternalNotificationService);

    await dismiss.execute(
      { recommendationId: RECOMMENDATION_ID, reason: 'no longer relevant' },
      { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID },
    );

    expect(recommendationService.dismiss).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID, RECOMMENDATION_ID, 'no longer relevant');
  });

  it('complete.execute calls RecommendationService.complete with the context workspaceId/customerId', async () => {
    const recommendationService = makeRecommendationService();
    const { complete } = buildActionRegistry(recommendationService, {} as OrderService, {} as InternalNotificationService);

    await complete.execute({ recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID });

    expect(recommendationService.complete).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID, RECOMMENDATION_ID);
  });

  it('dismiss input schema rejects a non-uuid recommendationId', () => {
    const { dismiss } = buildActionRegistry(makeRecommendationService(), {} as OrderService, {} as InternalNotificationService);

    expect(dismiss.inputSchema.safeParse({ recommendationId: 'not-a-uuid' }).success).toBe(false);
  });

  it('complete input schema requires recommendationId', () => {
    const { complete } = buildActionRegistry(makeRecommendationService(), {} as OrderService, {} as InternalNotificationService);

    expect(complete.inputSchema.safeParse({}).success).toBe(false);
  });

  it('summarizes the result without leaking recommendation text', () => {
    const { dismiss } = buildActionRegistry(makeRecommendationService(), {} as OrderService, {} as InternalNotificationService);

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
    const { refundRequest } = buildActionRegistry(makeRecommendationService(), makeOrderService({ amount: '1.00' }), {} as InternalNotificationService);
    expect(refundRequest).toMatchObject({ name: 'order.refund_request', riskLevel: 'high', requiresApproval: true, allowedRoles: ['owner', 'admin'] });
  });

  it('accepts only orderId + reason (≤500 chars); never an amount, workspace or customer', () => {
    const { refundRequest } = buildActionRegistry(makeRecommendationService(), makeOrderService({ amount: '1.00' }), {} as InternalNotificationService);
    expect(refundRequest.inputSchema.safeParse({ orderId: ORDER_ID, reason: 'x'.repeat(500) }).success).toBe(true);
    expect(refundRequest.inputSchema.safeParse({ orderId: ORDER_ID, reason: 'x'.repeat(501) }).success).toBe(false);
    expect(refundRequest.inputSchema.safeParse({ orderId: ORDER_ID, reason: '' }).success).toBe(false);
    expect(refundRequest.inputSchema.safeParse({ orderId: 'not-a-uuid', reason: 'x' }).success).toBe(false);
    const parsed = refundRequest.inputSchema.parse({ orderId: ORDER_ID, reason: 'x', amount: '999', workspaceId: 'ws_2', customerId: 'c' });
    expect(parsed).toEqual({ orderId: ORDER_ID, reason: 'x' });
  });

  it('validates against the context customer and scopes pending requests by order', async () => {
    const orderService = makeOrderService({ reason: 'The order is cancelled.' });
    const { refundRequest } = buildActionRegistry(makeRecommendationService(), orderService, {} as InternalNotificationService);
    expect(await refundRequest.validate!({ orderId: ORDER_ID, reason: 'x' }, context)).toBe('The order is cancelled.');
    expect(orderService.findRefundableAmount).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID, ORDER_ID);
    expect(refundRequest.pendingScope!({ orderId: ORDER_ID, reason: 'x' })).toEqual({ orderId: ORDER_ID });
  });

  it('executes as a simulation with the computed amount, and fails rather than simulate an invalid refund', async () => {
    const { refundRequest } = buildActionRegistry(makeRecommendationService(), makeOrderService({ amount: '24.50' }), {} as InternalNotificationService);
    const result = await refundRequest.execute({ orderId: ORDER_ID, reason: 'x' }, context);
    expect(result).toEqual({ mode: 'simulated', orderId: ORDER_ID, amount: '24.50' });
    expect(refundRequest.summarizeResult!(result)).toEqual({ mode: 'simulated', orderId: ORDER_ID, amount: '24.50' });

    const invalid = buildActionRegistry(makeRecommendationService(), makeOrderService({ reason: 'The order is cancelled.' }), {} as InternalNotificationService).refundRequest;
    await expect(invalid.execute({ orderId: ORDER_ID, reason: 'x' }, context)).rejects.toThrow('The order is cancelled.');
  });
});

describe('internal_notification.create definition (#9, Nov 2, 2026)', () => {
  const OPPORTUNITY_ID = '44444444-4444-4444-8444-444444444444';
  const context = { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID };

  it('is low risk, needs no approval, and no human or AI role may invoke it', () => {
    const { internalNotificationCreate } = buildActionRegistry(makeRecommendationService(), {} as OrderService, {} as InternalNotificationService);
    expect(internalNotificationCreate).toMatchObject({ name: INTERNAL_NOTIFICATION_CREATE_ACTION, riskLevel: 'low', requiresApproval: false, allowedRoles: [] });
  });

  it('accepts only opportunityId; customer/type/priority/reason are never input', () => {
    const { internalNotificationCreate } = buildActionRegistry(makeRecommendationService(), {} as OrderService, {} as InternalNotificationService);
    expect(internalNotificationCreate.inputSchema.safeParse({ opportunityId: 'not-a-uuid' }).success).toBe(false);
    expect(internalNotificationCreate.inputSchema.safeParse({}).success).toBe(false);
    const parsed = internalNotificationCreate.inputSchema.parse({ opportunityId: OPPORTUNITY_ID, canonicalCustomerId: 'c', type: 'reorder', priority: 'high', reason: 'x' });
    expect(parsed).toEqual({ opportunityId: OPPORTUNITY_ID });
  });

  it('executes against the context workspace/customer and summarizes to the notification id', async () => {
    const service = { createForOpportunity: vi.fn(async () => ({ id: 'notif_1', created: true })) } as unknown as InternalNotificationService;
    const { internalNotificationCreate } = buildActionRegistry(makeRecommendationService(), {} as OrderService, service);
    const result = await internalNotificationCreate.execute({ opportunityId: OPPORTUNITY_ID }, context);
    expect(service.createForOpportunity).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID, OPPORTUNITY_ID);
    expect(internalNotificationCreate.summarizeResult!(result)).toEqual({ notificationId: 'notif_1', created: true });
  });
});
