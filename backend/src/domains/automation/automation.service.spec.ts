import { describe, expect, it, vi } from 'vitest';
import { AutomationService } from './automation.service';
import type { DatabaseService } from '../../database/database.service';
import type { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import type { AiActionControlService } from '../ai-action-control/ai-action-control.service';
import type { ActionRegistry } from '../ai-action-control/actions.registry';
import type { DomainEvent } from '../../common/events/domain-event';
import type { RevenueOpportunityCreatedPayload } from '../intelligence-engines/revenue-opportunity.service';
import type { CustomerHealthRecalculatedPayload } from '../intelligence-engines/customer-health.service';

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

/** `executeForAutomation` is mocked at this boundary — these tests exercise `AutomationService.runOne()`'s own orchestration, not `AiActionControlService`'s internals (covered separately in `ai-action-control.service.spec.ts`). */
function makeAiActionControl(overrides: { executeForAutomation?: (...args: unknown[]) => Promise<unknown> } = {}): AiActionControlService {
  return {
    executeForAutomation: vi.fn(async () => [{ id: 'rec_1' }]),
    ...overrides,
  } as unknown as AiActionControlService;
}

/** Opaque marker — `runOne()` only ever forwards this reference to `executeForAutomation` (mocked above), it never inspects the definition itself in these tests. */
function makeRegistry(): ActionRegistry {
  return { generateRecommendations: { name: 'generate_recommendations' } } as unknown as ActionRegistry;
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

function makeHealthEvent(payload: Partial<CustomerHealthRecalculatedPayload> = {}): DomainEvent<CustomerHealthRecalculatedPayload> {
  return {
    id: 'evt_health_1',
    type: 'customer_health.recalculated',
    version: 1,
    workspaceId: 'ws_1',
    entityId: 'canon_1',
    occurredAt: new Date().toISOString(),
    payload: {
      canonicalCustomerId: 'canon_1',
      score: null,
      healthCategory: null,
      trend: null,
      reasonCodes: [],
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
        makeAiActionControl(),
        makeRegistry(),
        makeLogger(),
      );

      const result = await service.create('ws_1', { name: 'Notify on win-back', triggerType: 'revenue_opportunity.created', conditions: undefined });

      expect(result).toEqual(created);
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ triggerType: 'revenue_opportunity.created', actionType: 'generate_recommendations' }),
      );
    });

    it('fixes actionType regardless of triggerType, and passes through a customer_health.recalculated trigger unchanged', async () => {
      const created = { id: 'auto_2', name: 'Reach out on health change' };
      const insertChain = makeInsertChain(created);
      const insert = vi.fn(() => insertChain);
      const service = new AutomationService(
        { client: { insert } } as unknown as DatabaseService,
        makeAiActionControl(),
        makeRegistry(),
        makeLogger(),
      );

      const result = await service.create('ws_1', { name: 'Reach out on health change', triggerType: 'customer_health.recalculated', conditions: undefined });

      expect(result).toEqual(created);
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ triggerType: 'customer_health.recalculated', actionType: 'generate_recommendations' }),
      );
    });
  });

  describe('update()', () => {
    it('throws NotFoundError when the automation does not exist in this workspace', async () => {
      const select = makeSelectQueue([[]]);
      const service = new AutomationService(
        { client: { select } } as unknown as DatabaseService,
        makeAiActionControl(),
        makeRegistry(),
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
        makeAiActionControl(),
        makeRegistry(),
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
        makeAiActionControl(),
        makeRegistry(),
        makeLogger(),
      );

      await expect(service.get('ws_1', 'auto_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns the automation', async () => {
      const automation = { id: 'auto_1', name: 'X' };
      const select = makeSelectQueue([[automation]]);
      const service = new AutomationService(
        { client: { select } } as unknown as DatabaseService,
        makeAiActionControl(),
        makeRegistry(),
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
        makeAiActionControl(),
        makeRegistry(),
        makeLogger(),
      );

      const result = await service.list('ws_1');

      expect(result).toEqual(rows);
    });

    it('listRuns() throws NotFoundError when the automation does not exist', async () => {
      const select = makeSelectQueue([[]]);
      const service = new AutomationService(
        { client: { select } } as unknown as DatabaseService,
        makeAiActionControl(),
        makeRegistry(),
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
        makeAiActionControl(),
        makeRegistry(),
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
        makeAiActionControl(),
        makeRegistry(),
        makeLogger(),
      );

      await service.handleRevenueOpportunityCreated(makeEvent());

      expect(insert).not.toHaveBeenCalled();
    });

    it('records a skipped run when conditions do not match, without ever calling AI Action Control', async () => {
      const definition = { id: 'auto_1', conditions: { priorityIn: ['critical'] } };
      const select = makeSelectQueue([[definition]]);
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const aiActionControl = makeAiActionControl();
      const service = new AutomationService(
        { client: { select, insert } } as unknown as DatabaseService,
        aiActionControl,
        makeRegistry(),
        makeLogger(),
      );

      await service.handleRevenueOpportunityCreated(makeEvent({ priority: 'high' }));

      expect(aiActionControl.executeForAutomation).not.toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped', automationId: 'auto_1' }));
    });

    it('runs the action through AiActionControlService.executeForAutomation and records a succeeded run when conditions match', async () => {
      const definition = { id: 'auto_1', conditions: { priorityIn: ['high'] } };
      const select = makeSelectQueue([[definition]]);
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const registry = makeRegistry();
      const aiActionControl = makeAiActionControl({ executeForAutomation: vi.fn(async () => [{ id: 'rec_1' }]) });
      const service = new AutomationService(
        { client: { select, insert } } as unknown as DatabaseService,
        aiActionControl,
        registry,
        makeLogger(),
      );

      await service.handleRevenueOpportunityCreated(makeEvent({ priority: 'high' }));

      expect(aiActionControl.executeForAutomation).toHaveBeenCalledWith(
        registry.generateRecommendations,
        {},
        { workspaceId: 'ws_1', customerId: 'canon_1' },
        'auto_1:evt_1',
        'evt_1',
      );
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'succeeded', result: { recommendationsCount: 1 } }),
      );
    });

    it('records a failed run when AI Action Control rejects the action, without propagating the error', async () => {
      const definition = { id: 'auto_1', conditions: null };
      const select = makeSelectQueue([[definition]]);
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const aiActionControl = makeAiActionControl({
        executeForAutomation: vi.fn(async () => {
          throw new Error('boom');
        }),
      });
      const service = new AutomationService(
        { client: { select, insert } } as unknown as DatabaseService,
        aiActionControl,
        makeRegistry(),
        makeLogger(),
      );

      await expect(service.handleRevenueOpportunityCreated(makeEvent())).resolves.toBeUndefined();

      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', reason: 'boom' }));
    });

    it('matches on typeIn as well as priorityIn', async () => {
      const definition = { id: 'auto_1', conditions: { typeIn: ['win_back'] } };
      const select = makeSelectQueue([[definition]]);
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const aiActionControl = makeAiActionControl();
      const service = new AutomationService(
        { client: { select, insert } } as unknown as DatabaseService,
        aiActionControl,
        makeRegistry(),
        makeLogger(),
      );

      await service.handleRevenueOpportunityCreated(makeEvent({ type: 'reorder' }));

      expect(aiActionControl.executeForAutomation).not.toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
    });
  });

  describe('handleCustomerHealthRecalculated()', () => {
    it('does nothing when the event carries no workspaceId', async () => {
      const select = vi.fn();
      const service = new AutomationService(
        { client: { select } } as unknown as DatabaseService,
        makeAiActionControl(),
        makeRegistry(),
        makeLogger(),
      );

      await service.handleCustomerHealthRecalculated({ ...makeHealthEvent(), workspaceId: undefined });

      expect(select).not.toHaveBeenCalled();
    });

    it('scopes the definition lookup to the workspace and the customer_health.recalculated trigger type', async () => {
      const select = makeSelectQueue([[]]);
      const client = { select, insert: vi.fn() };
      const service = new AutomationService({ client } as unknown as DatabaseService, makeAiActionControl(), makeRegistry(), makeLogger());

      await service.handleCustomerHealthRecalculated(makeHealthEvent());

      expect(select).toHaveBeenCalledTimes(1);
    });

    it('inserts no run when no enabled automation matches this trigger type', async () => {
      const select = makeSelectQueue([[]]);
      const insert = vi.fn();
      const service = new AutomationService(
        { client: { select, insert } } as unknown as DatabaseService,
        makeAiActionControl(),
        makeRegistry(),
        makeLogger(),
      );

      await service.handleCustomerHealthRecalculated(makeHealthEvent());

      expect(insert).not.toHaveBeenCalled();
    });

    it('runs the action through AiActionControlService.executeForAutomation and records a succeeded run — health automations are unconditional', async () => {
      const definition = { id: 'auto_health_1', conditions: null };
      const select = makeSelectQueue([[definition]]);
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const registry = makeRegistry();
      const aiActionControl = makeAiActionControl({ executeForAutomation: vi.fn(async () => [{ id: 'rec_1' }]) });
      const service = new AutomationService(
        { client: { select, insert } } as unknown as DatabaseService,
        aiActionControl,
        registry,
        makeLogger(),
      );

      await service.handleCustomerHealthRecalculated(makeHealthEvent());

      expect(aiActionControl.executeForAutomation).toHaveBeenCalledWith(
        registry.generateRecommendations,
        {},
        { workspaceId: 'ws_1', customerId: 'canon_1' },
        'auto_health_1:evt_health_1',
        'evt_health_1',
      );
      expect(insertChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'succeeded', result: { recommendationsCount: 1 }, automationId: 'auto_health_1', triggerEventId: 'evt_health_1' }),
      );
    });

    it('a definition-level `conditions` value is accepted but has no effect — the automation still fires', async () => {
      const definition = { id: 'auto_health_1', conditions: { priorityIn: ['critical'] } };
      const select = makeSelectQueue([[definition]]);
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const aiActionControl = makeAiActionControl();
      const service = new AutomationService(
        { client: { select, insert } } as unknown as DatabaseService,
        aiActionControl,
        makeRegistry(),
        makeLogger(),
      );

      await service.handleCustomerHealthRecalculated(makeHealthEvent());

      expect(aiActionControl.executeForAutomation).toHaveBeenCalled();
      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ status: 'succeeded' }));
    });

    it('records a failed run when AI Action Control rejects the action, without propagating the error', async () => {
      const definition = { id: 'auto_health_1', conditions: null };
      const select = makeSelectQueue([[definition]]);
      const insertChain = makeInsertChain();
      const insert = vi.fn(() => insertChain);
      const aiActionControl = makeAiActionControl({
        executeForAutomation: vi.fn(async () => {
          throw new Error('boom');
        }),
      });
      const service = new AutomationService(
        { client: { select, insert } } as unknown as DatabaseService,
        aiActionControl,
        makeRegistry(),
        makeLogger(),
      );

      await expect(service.handleCustomerHealthRecalculated(makeHealthEvent())).resolves.toBeUndefined();

      expect(insertChain.values).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', reason: 'boom' }));
    });

    it('a run failure never propagates back to the caller (fault isolation from the event producer)', async () => {
      const definition = { id: 'auto_health_1', conditions: null };
      const logger = makeLogger();
      // Forces runOne's own per-definition try/catch to trigger by making its insert throw.
      const throwingClient = {
        select: vi.fn(() => makeSelectChain([definition])),
        insert: vi.fn(() => {
          throw new Error('insert exploded');
        }),
      };
      const service = new AutomationService({ client: throwingClient } as unknown as DatabaseService, makeAiActionControl(), makeRegistry(), logger);

      await expect(service.handleCustomerHealthRecalculated(makeHealthEvent())).resolves.toBeUndefined();

      expect(logger.event).toHaveBeenCalledWith(
        'error',
        'Automation auto_health_1 run threw unexpectedly',
        'AutomationService',
        expect.objectContaining({ automationId: 'auto_health_1' }),
      );
    });
  });
});
