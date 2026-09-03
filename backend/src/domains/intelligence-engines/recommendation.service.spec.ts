import { describe, expect, it, vi } from 'vitest';
import { RecommendationService } from './recommendation.service';
import type { DatabaseService } from '../../database/database.service';
import type { RevenueOpportunityService } from './revenue-opportunity.service';

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

function makeSelectQueue(results: unknown[]) {
  let i = 0;
  return vi.fn(() => makeSelectChain(results[i++]));
}

function makeInsertChain() {
  return { values: vi.fn(async () => undefined) };
}

const OPPORTUNITY = {
  id: 'opp_1',
  type: 'win_back',
  priority: 'high',
  estimatedRevenue: '50.00',
  confidence: 80,
  reason: 'No order in 150 day(s).',
  recommendedAction: 'Send a win-back offer to re-engage this customer.',
};

function makeRevenueOpportunityService(opportunities: unknown[]): RevenueOpportunityService {
  return { list: vi.fn(async () => opportunities) } as unknown as RevenueOpportunityService;
}

describe('RecommendationService', () => {
  describe('generate()', () => {
    it('creates no recommendations when there are no open opportunities', async () => {
      const insert = vi.fn();
      const select = makeSelectQueue([[]]); // getExistingOpportunityIds skipped (no ids); list()
      const client = { select, insert };
      const service = new RecommendationService({ client } as unknown as DatabaseService, makeRevenueOpportunityService([]));

      const result = await service.generate('ws_1', 'canon_1');

      expect(insert).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('generates a recommendation from an open opportunity that has none yet', async () => {
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const select = makeSelectQueue([[], []]); // getExistingOpportunityIds -> none, then list()
      const client = { select, insert };
      const service = new RecommendationService({ client } as unknown as DatabaseService, makeRevenueOpportunityService([OPPORTUNITY]));

      await service.generate('ws_1', 'canon_1');

      expect(insertChain.values).toHaveBeenCalledWith([
        expect.objectContaining({
          sourceOpportunityId: 'opp_1',
          text: OPPORTUNITY.recommendedAction,
          state: 'active',
          supportingSignals: expect.objectContaining({ opportunityType: 'win_back', confidence: 80 }),
        }),
      ]);
    });

    it('skips an opportunity that already has a recommendation', async () => {
      const insert = vi.fn();
      const select = makeSelectQueue([[{ sourceOpportunityId: 'opp_1' }], []]);
      const client = { select, insert };
      const service = new RecommendationService({ client } as unknown as DatabaseService, makeRevenueOpportunityService([OPPORTUNITY]));

      await service.generate('ws_1', 'canon_1');

      expect(insert).not.toHaveBeenCalled();
    });
  });

  describe('list()', () => {
    it('returns whatever the query yields', async () => {
      const rows = [{ id: 'rec_1', state: 'active' }];
      const select = vi.fn(() => makeSelectChain(rows));
      const client = { select };
      const service = new RecommendationService({ client } as unknown as DatabaseService, {} as RevenueOpportunityService);

      const result = await service.list('ws_1', 'canon_1');

      expect(result).toEqual(rows);
    });
  });

  describe('dismiss()', () => {
    it('throws NotFoundError when the recommendation does not exist', async () => {
      const select = makeSelectQueue([[]]);
      const client = { select };
      const service = new RecommendationService({ client } as unknown as DatabaseService, {} as RevenueOpportunityService);

      await expect(service.dismiss('ws_1', 'canon_1', 'rec_1')).rejects.toThrow('No recommendation with that id exists for this customer.');
    });

    it('throws ConflictError when the recommendation is not active', async () => {
      const select = makeSelectQueue([[{ id: 'rec_1', state: 'completed' }]]);
      const client = { select };
      const service = new RecommendationService({ client } as unknown as DatabaseService, {} as RevenueOpportunityService);

      await expect(service.dismiss('ws_1', 'canon_1', 'rec_1')).rejects.toThrow('Recommendation is already completed.');
    });

    it('updates an active recommendation to dismissed', async () => {
      const select = makeSelectQueue([[{ id: 'rec_1', state: 'active' }]]);
      const updated = { id: 'rec_1', state: 'dismissed' };
      const update = vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => [updated]),
          })),
        })),
      }));
      const client = { select, update };
      const service = new RecommendationService({ client } as unknown as DatabaseService, {} as RevenueOpportunityService);

      const result = await service.dismiss('ws_1', 'canon_1', 'rec_1', 'Not relevant');

      expect(result).toEqual(updated);
    });
  });
});
