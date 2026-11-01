import { describe, expect, it, vi } from 'vitest';
import { RecommendationService } from './recommendation.service';
import type { DatabaseService } from '../../database/database.service';
import type { RevenueOpportunityService } from './revenue-opportunity.service';
import type { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { createEvent } from '../../common/events/domain-event';

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
  const onConflictDoNothing = vi.fn(async () => undefined);
  return { values: vi.fn(() => ({ onConflictDoNothing })), onConflictDoNothing };
}

function makeUpdateChain(returning: unknown[] = []) {
  const where = vi.fn(() => ({ returning: vi.fn(async () => returning), then: (resolve: (value: unknown) => void) => resolve(undefined) }));
  const set = vi.fn(() => ({ where }));
  return { set, where };
}

/** Each `update()` call gets the next chain. */
function makeUpdateQueue(chains: ReturnType<typeof makeUpdateChain>[]) {
  let i = 0;
  return vi.fn(() => chains[i++]);
}

/** `transaction` runs its callback against the same mocked client. */
function makeDatabase(client: Record<string, unknown>): DatabaseService {
  return { client, transaction: async (fn: (tx: unknown) => unknown) => fn(client) } as unknown as DatabaseService;
}

function makeLogger() {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
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
      const service = new RecommendationService({ client } as unknown as DatabaseService, makeRevenueOpportunityService([]), makeLogger());

      const result = await service.generate('ws_1', 'canon_1');

      expect(insert).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('generates a recommendation from an open opportunity that has none yet', async () => {
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const select = makeSelectQueue([[], []]); // getExistingRecommendationStates -> none, then list()
      const statusUpdate = makeUpdateChain();
      const client = { select, insert, update: makeUpdateQueue([statusUpdate]) };
      const service = new RecommendationService({ client } as unknown as DatabaseService, makeRevenueOpportunityService([OPPORTUNITY]), makeLogger());

      await service.generate('ws_1', 'canon_1');

      expect(statusUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'recommended' }));

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
      const select = makeSelectQueue([[{ sourceOpportunityId: 'opp_1', state: 'active' }], []]);
      const statusUpdate = makeUpdateChain();
      const client = { select, insert, update: makeUpdateQueue([statusUpdate]) };
      const service = new RecommendationService({ client } as unknown as DatabaseService, makeRevenueOpportunityService([OPPORTUNITY]), makeLogger());

      await service.generate('ws_1', 'canon_1');

      expect(insert).not.toHaveBeenCalled();
      // Still surfaced, so a pre-existing `new` opportunity catches up to `recommended`.
      expect(statusUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'recommended' }));
    });

    it('does not mark an opportunity recommended when its recommendation was already dismissed or completed', async () => {
      const update = vi.fn();
      const select = makeSelectQueue([[{ sourceOpportunityId: 'opp_1', state: 'dismissed' }], []]);
      const client = { select, insert: vi.fn(), update };
      const service = new RecommendationService({ client } as unknown as DatabaseService, makeRevenueOpportunityService([OPPORTUNITY]), makeLogger());

      await service.generate('ws_1', 'canon_1');

      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('list()', () => {
    it('returns whatever the query yields', async () => {
      const rows = [{ id: 'rec_1', state: 'active' }];
      const select = vi.fn(() => makeSelectChain(rows));
      const client = { select };
      const service = new RecommendationService({ client } as unknown as DatabaseService, {} as RevenueOpportunityService, makeLogger());

      const result = await service.list('ws_1', 'canon_1');

      expect(result).toEqual(rows);
    });
  });

  describe('dismiss()', () => {
    it('throws NotFoundError when the recommendation does not exist', async () => {
      const select = makeSelectQueue([[]]);
      const client = { select };
      const service = new RecommendationService({ client } as unknown as DatabaseService, {} as RevenueOpportunityService, makeLogger());

      await expect(service.dismiss('ws_1', 'canon_1', 'rec_1')).rejects.toThrow('No recommendation with that id exists for this customer.');
    });

    it('throws ConflictError when the recommendation is not active', async () => {
      const select = makeSelectQueue([[{ id: 'rec_1', state: 'completed' }]]);
      const client = { select };
      const service = new RecommendationService({ client } as unknown as DatabaseService, {} as RevenueOpportunityService, makeLogger());

      await expect(service.dismiss('ws_1', 'canon_1', 'rec_1')).rejects.toThrow('Recommendation is already completed.');
    });

    it('updates an active recommendation to dismissed and moves its own source opportunity to ignored', async () => {
      const select = makeSelectQueue([[{ id: 'rec_1', state: 'active', sourceOpportunityId: 'opp_1' }]]);
      const updated = { id: 'rec_1', state: 'dismissed' };
      const opportunityUpdate = makeUpdateChain();
      const update = makeUpdateQueue([makeUpdateChain([updated]), opportunityUpdate]);
      const service = new RecommendationService(makeDatabase({ select, update }), {} as RevenueOpportunityService, makeLogger());

      const result = await service.dismiss('ws_1', 'canon_1', 'rec_1', 'Not relevant');

      expect(result).toEqual(updated);
      expect(opportunityUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'ignored', closedReason: 'recommendation_dismissed' }));
    });

    it('throws ConflictError when a racing close already moved the recommendation out of active', async () => {
      const select = makeSelectQueue([[{ id: 'rec_1', state: 'active', sourceOpportunityId: 'opp_1' }]]);
      const update = makeUpdateQueue([makeUpdateChain([])]);
      const service = new RecommendationService(makeDatabase({ select, update }), {} as RevenueOpportunityService, makeLogger());

      await expect(service.dismiss('ws_1', 'canon_1', 'rec_1')).rejects.toThrow('Recommendation is no longer active.');
      expect(update).toHaveBeenCalledTimes(1);
    });
  });

  describe('complete()', () => {
    it('completes the recommendation and moves its own source opportunity to executed', async () => {
      const select = makeSelectQueue([[{ id: 'rec_1', state: 'active', sourceOpportunityId: 'opp_1' }]]);
      const updated = { id: 'rec_1', state: 'completed' };
      const opportunityUpdate = makeUpdateChain();
      const update = makeUpdateQueue([makeUpdateChain([updated]), opportunityUpdate]);
      const service = new RecommendationService(makeDatabase({ select, update }), {} as RevenueOpportunityService, makeLogger());

      const result = await service.complete('ws_1', 'canon_1', 'rec_1');

      expect(result).toEqual(updated);
      expect(opportunityUpdate.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'executed' }));
    });

    it('does not touch the opportunity when the recommendation is not active', async () => {
      const select = makeSelectQueue([[{ id: 'rec_1', state: 'completed', sourceOpportunityId: 'opp_1' }]]);
      const update = vi.fn();
      const service = new RecommendationService(makeDatabase({ select, update }), {} as RevenueOpportunityService, makeLogger());

      await expect(service.complete('ws_1', 'canon_1', 'rec_1')).rejects.toThrow('Recommendation is already completed.');
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('countActiveByWorkspace()', () => {
    it('returns the active count for the workspace', async () => {
      const select = makeSelectQueue([[{ count: 7 }]]);
      const client = { select };
      const service = new RecommendationService({ client } as unknown as DatabaseService, {} as RevenueOpportunityService, makeLogger());

      const result = await service.countActiveByWorkspace('ws_1');

      expect(result).toBe(7);
    });
  });

  describe('handleEvaluationTrigger() — automatic evaluation (Milestone #5 D5)', () => {
    function makeEvaluation() {
      const opportunities = { detect: vi.fn(async () => []), list: vi.fn(async () => []), evaluateConversions: vi.fn(async () => 0) } as unknown as RevenueOpportunityService;
      const client = { select: makeSelectQueue([[], []]), insert: vi.fn() };
      const logger = makeLogger();
      const service = new RecommendationService({ client } as unknown as DatabaseService, opportunities, logger);
      return { service, opportunities, logger };
    }

    for (const type of ['order.created', 'order.cancelled', 'refund.processed', 'customer_health.recalculated']) {
      it(`detects opportunities, then generates recommendations, on ${type}`, async () => {
        const { service, opportunities } = makeEvaluation();
        const generate = vi.spyOn(service, 'generate');

        await service.handleEvaluationTrigger(createEvent({ type, workspaceId: 'ws_1', payload: { canonicalCustomerId: 'canon_1' } }));

        expect(opportunities.detect).toHaveBeenCalledWith('ws_1', 'canon_1');
        expect(generate).toHaveBeenCalledWith('ws_1', 'canon_1');
        expect(vi.mocked(opportunities.detect).mock.invocationCallOrder[0]).toBeLessThan(generate.mock.invocationCallOrder[0]);
        if (type === 'order.created') {
          expect(opportunities.evaluateConversions).toHaveBeenCalledWith('ws_1', 'canon_1');
          expect(vi.mocked(opportunities.evaluateConversions).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(opportunities.detect).mock.invocationCallOrder[0]);
        } else {
          expect(opportunities.evaluateConversions).not.toHaveBeenCalled();
        }
      });
    }

    it('skips an event with no canonical customer (unresolved/guest order) or no workspace', async () => {
      const { service, opportunities } = makeEvaluation();

      await service.handleEvaluationTrigger(createEvent({ type: 'order.created', workspaceId: 'ws_1', payload: { canonicalCustomerId: null } }));
      await service.handleEvaluationTrigger({ ...createEvent({ type: 'order.created', payload: { canonicalCustomerId: 'canon_1' } }), workspaceId: undefined });

      expect(opportunities.detect).not.toHaveBeenCalled();
    });

    it('logs and swallows a failure so the emitting write is never affected', async () => {
      const { service, opportunities, logger } = makeEvaluation();
      vi.mocked(opportunities.detect).mockRejectedValueOnce(new Error('boom'));

      await expect(
        service.handleEvaluationTrigger(createEvent({ type: 'refund.processed', workspaceId: 'ws_1', payload: { canonicalCustomerId: 'canon_1' } })),
      ).resolves.toBeUndefined();
      expect(logger.event).toHaveBeenCalledWith('error', expect.stringContaining('refund.processed'), 'RecommendationService', expect.objectContaining({ error: 'boom' }));
    });
  });

  describe('generate() — concurrent evaluation', () => {
    it('inserts with ON CONFLICT DO NOTHING so a racing evaluation cannot duplicate a recommendation', async () => {
      const insertChain = makeInsertChain();
      const client = { select: makeSelectQueue([[], []]), insert: vi.fn(() => insertChain), update: makeUpdateQueue([makeUpdateChain()]) };
      const service = new RecommendationService({ client } as unknown as DatabaseService, makeRevenueOpportunityService([OPPORTUNITY]), makeLogger());

      await service.generate('ws_1', 'canon_1');

      expect(insertChain.onConflictDoNothing).toHaveBeenCalled();
    });
  });
});
