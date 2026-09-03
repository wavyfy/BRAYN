import { describe, expect, it, vi } from 'vitest';
import { AutomationService } from './automation.service';
import type { DatabaseService } from '../../database/database.service';
import type { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import type { RecommendationService } from '../intelligence-engines/recommendation.service';
import type { DomainEvent } from '../../common/events/domain-event';
import type { RevenueOpportunityCreatedPayload } from '../intelligence-engines/revenue-opportunity.service';

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => result),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

function makeSelectQueue(results: unknown[]) {
  let i = 0;
  return vi.fn(() => makeSelectChain(results[i++]));
}

function makeInsertChain(result?: unknown) {
  if (result === undefined) {
    return { values: vi.fn(async () => undefined) };
  }
  return { values: vi.fn(() => ({ returning: vi.fn(async () => [result]) })) };
}

function makeLogger() {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

function makeEvent(payload: Partial<RevenueOpportunityCreatedPayload> = {}): DomainEvent<RevenueOpportunityCreatedPayload> {
  return {
    id: 'evt_1',
    type: 'revenue_opportunity.created',
    version: 1,
    workspaceId: 'ws_1',
    entityId: 'opp_1',
    occurredAt: new Date().toISOString(),
    payload: {
      opportunityId: 'opp_1',
      canonicalCustomerId: 'canon_1',
      type: 'win_back',
      priority: 'high',
      estimatedRevenue: null,
      confidence: 80,
      ...payload,
    },
  };
}

describe('AutomationService', () => {
  describe('create()', () => {
    it('fixes triggerType/actionType to the only wired pair', async () => {
      const created = { id: 'auto_1', name: 'Notify on win-back' };
      const insertChain = makeInsertChain(created);
      const insert = vi.fn(() => insertChain);
      const service = new AutomationService(
        { client: { insert } } as unknown as DatabaseService,
        {} as RecommendationService,
        makeLogger(),
      );

      const result = await service.create('ws_1', { name: 'Notify on win-back', conditions: undefined });

      expect(result).toEqual(created);
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ triggerType: 'revenue_opportunity.created', actionType: 'generate_recommendations' }),
      );
    });
  });

  describe('update()', () => {
    it('throws NotFoundError when the automation does not exist in this workspace', async () => {
      const select = makeSelectQueue([[]]);
      const service = new AutomationService(
        { client: { select } } as unknown as DatabaseService,
        {} as RecommendationService,
        makeLogger(),
      );

      await expect(service.update('ws_1', 'auto_missing', { enabled: false })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('keeps unset fields and applies the change', async () => {
      const current = { id: 'auto_1', name: 'X', conditions: null, enabled: true };
      const updated = { ...current, enabled: false };
      const select = makeSelectQueue([[current]]);
      const updateChain = { set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [updated]) })) })) };
      const update = vi.fn(() => updateChain);
      const service = new AutomationService(
        { client: { select, update } } as unknown as DatabaseService,
        {} as RecommendationService,
        makeLogger(),
      );

      const result = await service.update('ws_1', 'auto_1', { enabled: false });

      expect(result).toEqual(updated);
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ name: 'X', enabled: false }));
    });
  });

  describe('get()', () => {
    it('throws NotFoundError when the automation does not exist in this workspace', async () => {
      const select = makeSelectQueue([[]]);
      const service = new AutomationService(
        { client: { select } } as unknown as DatabaseService,
        {} as RecommendationService,
        makeLogger(),
      );

      await expect(service.get('ws_1', 'auto_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns the automation', async () => {
      const automation = { id: 'auto_1', name: 'X' };
      const select = makeSelectQueue([[automation]]);
      const service = new AutomationService(
        { client: { select } } as unknown as DatabaseService,
        {} as RecommendationService,
        makeLogger(),
      );

      const result = await service.get('ws_1', 'auto_1');

      expect(result).toEqual(automation);
    });
  });

  describe('list() / listRuns()', () => {
    it('list() returns whatever the query yields', async () => {
      const rows = [{ id: 'auto_1' }];
      const select = vi.fn(() => makeSelectChain(rows));
      const service = new AutomationService(
        { client: { select } } as unknown as DatabaseService,
        {} as RecommendationService,
        makeLogger(),
      );

      const result = await service.list('ws_1');

      expect(result).toEqual(rows);
    });

    it('listRuns() throws NotFoundError when the automation does not exist', async () => {
      const select = makeSelectQueue([[]]);
      const service = new AutomationService(
        { client: { select } } as unknown as DatabaseService,
        {} as RecommendationService,
        makeLogger(),
      );

      await expect(service.listRuns('ws_1', 'auto_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('handleRevenueOpportunityCreated()', () => {
    it('does nothing when the event carries no workspaceId', async () => {
      const select = vi.fn();
      const service = new AutomationService(
        { client: { select } } as unknown as DatabaseService,
        {} as RecommendationService,
        makeLogger(),
      );

      await service.handleRevenueOpportunityCreated({ ...makeEvent(), workspaceId: undefined });

      expect(select).not.toHaveBeenCalled();
    });

    it('inserts no run when no enabled automation matches this trigger type', async () => {
      const select = makeSelectQueue([[]]);
      const insert = vi.fn();
      const service = new AutomationService(
        { client: { select, insert } } as unknown as DatabaseService,
        {} as RecommendationService,
        makeLogger(),
      );

      await service.handleRevenueOpportunityCreated(makeEvent());

      expect(insert).not.toHaveBeenCalled();
    });

    it('records a skipped run when conditions do not match', async () => {
      const definition = { id: 'auto_1', conditions: { priorityIn: ['critical'] } };
      const select = makeSelectQueue([[definition]]);
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const recommendationService = { generate: vi.fn() } as unknown as RecommendationService;
      const service = new AutomationService({ client: { select, insert } } as unknown as DatabaseService, recommendationService, makeLogger());

      await service.handleRevenueOpportunityCreated(makeEvent({ priority: 'high' }));

      expect(recommendationService.generate).not.toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped', automationId: 'auto_1' }));
    });

    it('runs the action and records a succeeded run when conditions match', async () => {
      const definition = { id: 'auto_1', conditions: { priorityIn: ['high'] } };
      const select = makeSelectQueue([[definition]]);
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const recommendationService = { generate: vi.fn(async () => [{ id: 'rec_1' }]) } as unknown as RecommendationService;
      const service = new AutomationService({ client: { select, insert } } as unknown as DatabaseService, recommendationService, makeLogger());

      await service.handleRevenueOpportunityCreated(makeEvent({ priority: 'high' }));

      expect(recommendationService.generate).toHaveBeenCalledWith('ws_1', 'canon_1');
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'succeeded', result: { recommendationsCount: 1 } }),
      );
    });

    it('records a failed run when the action throws, without propagating the error', async () => {
      const definition = { id: 'auto_1', conditions: null };
      const select = makeSelectQueue([[definition]]);
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const recommendationService = { generate: vi.fn(async () => { throw new Error('boom'); }) } as unknown as RecommendationService;
      const service = new AutomationService({ client: { select, insert } } as unknown as DatabaseService, recommendationService, makeLogger());

      await expect(service.handleRevenueOpportunityCreated(makeEvent())).resolves.toBeUndefined();

      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', reason: 'boom' }));
    });

    it('matches on typeIn as well as priorityIn', async () => {
      const definition = { id: 'auto_1', conditions: { typeIn: ['win_back'] } };
      const select = makeSelectQueue([[definition]]);
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const recommendationService = { generate: vi.fn(async () => []) } as unknown as RecommendationService;
      const service = new AutomationService({ client: { select, insert } } as unknown as DatabaseService, recommendationService, makeLogger());

      await service.handleRevenueOpportunityCreated(makeEvent({ type: 'reorder' }));

      expect(recommendationService.generate).not.toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
    });
  });
});
