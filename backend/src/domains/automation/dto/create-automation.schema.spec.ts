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
