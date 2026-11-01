import { describe, expect, it } from 'vitest';
import { qualifyWebsiteIntent } from './revenue-opportunity.service';
import type { WebsiteProductIntent } from '../customer-intelligence/customer-intelligence.service';

const NOW = new Date('2026-11-01T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000);

function intent(overrides: Partial<WebsiteProductIntent> = {}): WebsiteProductIntent {
  return { productId: 'p1', title: 'Kettle', views: [], cartAdds: [], lastPurchasedAt: null, ...overrides };
}
const view = (h: number, sessionId: string) => ({ occurredAt: hoursAgo(h), sessionId });

describe('qualifyWebsiteIntent() — Milestone #5 Release 3 rules', () => {
  it('never qualifies on a single view', () => {
    expect(qualifyWebsiteIntent(intent({ views: [view(1, 's1')] }), NOW, null)).toBeNull();
  });

  it('needs at least 3 views', () => {
    expect(qualifyWebsiteIntent(intent({ views: [view(1, 's1'), view(30, 's2')] }), NOW, null)).toBeNull();
  });

  it('needs at least 2 distinct sessions — many views in one session do not qualify', () => {
    expect(qualifyWebsiteIntent(intent({ views: [view(1, 's1'), view(2, 's1'), view(3, 's1'), view(4, 's1')] }), NOW, null)).toBeNull();
  });

  it('qualifies 3 views across 2 sessions as medium view evidence with quantity 1, evidence at the latest view', () => {
    expect(qualifyWebsiteIntent(intent({ views: [view(50, 's1'), view(5, 's2'), view(49, 's1')] }), NOW, null)).toEqual({
      kind: 'views',
      quantity: 1,
      evidenceAt: hoursAgo(5),
      viewCount: 3,
      sessionCount: 2,
    });
  });

  it('does not qualify a cart add younger than 24 hours', () => {
    expect(qualifyWebsiteIntent(intent({ cartAdds: [{ occurredAt: hoursAgo(23), quantity: 2 }] }), NOW, null)).toBeNull();
  });

  it('qualifies a cart add at least 24 hours old with its quantity — and cart beats views', () => {
    const result = qualifyWebsiteIntent(
      intent({ views: [view(1, 's1'), view(2, 's2'), view(3, 's3')], cartAdds: [{ occurredAt: hoursAgo(30), quantity: 2 }, { occurredAt: hoursAgo(26), quantity: 3 }] }),
      NOW,
      null,
    );
    expect(result).toMatchObject({ kind: 'cart', quantity: 3, evidenceAt: hoursAgo(26) });
  });

  it('never offers a product the customer has purchased', () => {
    const purchased = intent({ views: [view(1, 's1'), view(2, 's2'), view(3, 's2')], cartAdds: [{ occurredAt: hoursAgo(30), quantity: 1 }], lastPurchasedAt: hoursAgo(400) });
    expect(qualifyWebsiteIntent(purchased, NOW, null)).toBeNull();
  });

  it('recreation rule: only evidence after the earlier closure counts', () => {
    const views = [view(60, 's1'), view(50, 's2'), view(40, 's2'), view(10, 's3')];
    expect(qualifyWebsiteIntent(intent({ views }), NOW, hoursAgo(20))).toBeNull(); // only 1 view after closure
    const more = [...views, view(5, 's3'), view(2, 's4')];
    expect(qualifyWebsiteIntent(intent({ views: more }), NOW, hoursAgo(20))).toMatchObject({ kind: 'views', viewCount: 3, sessionCount: 2 });
    expect(qualifyWebsiteIntent(intent({ cartAdds: [{ occurredAt: hoursAgo(30), quantity: 1 }] }), NOW, hoursAgo(20))).toBeNull();
  });
});
