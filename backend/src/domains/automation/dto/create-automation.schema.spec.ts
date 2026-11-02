import { describe, expect, it } from 'vitest';
import { createAutomationSchema, opportunityTypes } from './create-automation.schema';
import { updateAutomationSchema } from './update-automation.schema';
import type { OpportunityType } from '../../intelligence-engines/revenue-opportunity.service';

describe('automation typeIn conditions', () => {
  it('accepts every opportunity type the detector produces', () => {
    const detectorTypes: OpportunityType[] = ['reorder', 'win_back', 'vip_recognition', 'cross_sell', 'upsell', 'bundle'];
    expect([...opportunityTypes].sort()).toEqual([...detectorTypes].sort());

    for (const type of detectorTypes) {
      expect(createAutomationSchema.safeParse({ name: 'a', conditions: { typeIn: [type] } }).success).toBe(true);
      expect(updateAutomationSchema.safeParse({ conditions: { typeIn: [type] } }).success).toBe(true);
    }
    expect(createAutomationSchema.parse({ name: 'a', conditions: { typeIn: [...detectorTypes] } }).conditions?.typeIn).toEqual(detectorTypes);
  });

  it('rejects unknown opportunity types', () => {
    for (const type of ['review_request', 'referral', 'crossSell', '']) {
      expect(createAutomationSchema.safeParse({ name: 'a', conditions: { typeIn: [type] } }).success).toBe(false);
      expect(updateAutomationSchema.safeParse({ conditions: { typeIn: [type] } }).success).toBe(false);
    }
  });
});

describe('automation actionType', () => {
  it('defaults to generate_recommendations and accepts internal_notification.create with the revenue-opportunity trigger', () => {
    expect(createAutomationSchema.parse({ name: 'a' }).actionType).toBe('generate_recommendations');
    expect(createAutomationSchema.parse({ name: 'a', actionType: 'internal_notification.create' })).toMatchObject({
      triggerType: 'revenue_opportunity.created',
      actionType: 'internal_notification.create',
    });
    expect(createAutomationSchema.safeParse({ name: 'a', triggerType: 'customer_health.recalculated', actionType: 'generate_recommendations' }).success).toBe(true);
  });

  it('rejects internal_notification.create with the customer_health.recalculated trigger', () => {
    const result = createAutomationSchema.safeParse({ name: 'a', triggerType: 'customer_health.recalculated', actionType: 'internal_notification.create' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(['actionType']);
  });

  it('rejects unknown actions, including registry actions automation may not run', () => {
    for (const actionType of ['order.refund_request', 'recommendation.dismiss', 'send_whatsapp', '']) {
      expect(createAutomationSchema.safeParse({ name: 'a', actionType }).success).toBe(false);
    }
  });

  it('does not let an update change the action or trigger', () => {
    expect(updateAutomationSchema.parse({ name: 'b', actionType: 'internal_notification.create', triggerType: 'customer_health.recalculated' })).toEqual({ name: 'b' });
  });
});
