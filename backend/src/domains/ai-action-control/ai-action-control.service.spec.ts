import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiActionControlService } from './ai-action-control.service';
import { RequestContext } from '../../common/logging/request-context';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { DatabaseService } from '../../database/database.service';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { MerchantKnowledgeService } from '../merchant-knowledge/merchant-knowledge.service';
import { ApprovalRequiredError, ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../../common/errors/app-error';
import type { ActionDefinition } from './action-definition';
import type { ActionRegistry } from './actions.registry';

const WORKSPACE_ID = 'ws_1';
const OTHER_WORKSPACE_ID = 'ws_2';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const RECOMMENDATION_ID = '22222222-2222-4222-8222-222222222222';

function makeDatabase() {
  const values = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values }));
  return { database: { client: { insert } } as unknown as DatabaseService, insert, values };
}

function makeMerchantKnowledge(overrides: Partial<MerchantKnowledgeService> = {}): MerchantKnowledgeService {
  return { list: vi.fn(async () => []), ...overrides } as unknown as MerchantKnowledgeService;
}

function makeIdempotency(overrides: Partial<IdempotencyService> = {}): IdempotencyService {
  return {
    reserve: vi.fn(async () => true),
    complete: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as IdempotencyService;
}

function makeLogger(): StructuredLoggerService {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

function makeService(overrides: {
  database?: DatabaseService;
  merchantKnowledge?: MerchantKnowledgeService;
  idempotency?: IdempotencyService;
  logger?: StructuredLoggerService;
  registry?: ActionRegistry;
} = {}) {
  return new AiActionControlService(
    overrides.database ?? makeDatabase().database,
    overrides.merchantKnowledge ?? makeMerchantKnowledge(),
    overrides.idempotency ?? makeIdempotency(),
    overrides.logger ?? makeLogger(),
    overrides.registry ?? ({} as ActionRegistry),
  );
}

/** Doc19 Phase 14 Approval-Grant Workflow — a test-local registry so `approve()`/`deny()` can resolve a synthetic action by name, without registering a real medium/high-risk action in `actions.registry.ts`. */
function registryOf<TInput, TResult>(definition: ActionDefinition<TInput, TResult>): ActionRegistry {
  return { [definition.name]: definition } as unknown as ActionRegistry;
}

function contextFor(workspaceId: string, actorUserId: string) {
  return { correlationId: 'corr-1', userId: 'clerk_1', workspaceId, actorUserId, actorRole: 'owner' } as const;
}

function ownerContext<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(contextFor(WORKSPACE_ID, 'user_1'), fn);
}

function analystContext<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { correlationId: 'corr-2', userId: 'clerk_2', workspaceId: WORKSPACE_ID, actorUserId: 'user_2', actorRole: 'analyst' },
    fn,
  );
}

const lowRiskInputSchema = z.object({ recommendationId: z.string().uuid() });

function makeLowRiskAction(execute: ActionDefinition<{ recommendationId: string }, { id: string; state: string }>['execute']) {
  const definition: ActionDefinition<{ recommendationId: string }, { id: string; state: string }> = {
    name: 'recommendation.dismiss',
    description: 'test action',
    riskLevel: 'low',
    requiresApproval: false,
    allowedRoles: ['owner', 'admin', 'marketing', 'support'],
    inputSchema: lowRiskInputSchema,
    execute,
    summarizeResult: (result) => ({ recommendationId: result.id, state: result.state }),
  };
  return definition;
}

function makeHighRiskAction(): ActionDefinition<{ recommendationId: string }, { id: string }> {
  return {
    name: 'test.high-risk-action',
    description: 'a synthetic high-risk action, used only to exercise the generic approval-required path',
    riskLevel: 'high',
    requiresApproval: true,
    allowedRoles: ['owner', 'admin'],
    inputSchema: lowRiskInputSchema,
    execute: vi.fn(async () => ({ id: 'should-never-run' })),
  };
}

const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

/** Doc19 Phase 14 Approval-Grant Workflow — a test-local approvable action fixture, never registered in `actions.registry.ts` (instructed: do not invent a real medium/high-risk production action). */
function makeApprovableAction(
  execute: ActionDefinition<{ recommendationId: string }, { id: string; state: string }>['execute'],
): ActionDefinition<{ recommendationId: string }, { id: string; state: string }> {
  return {
    name: 'test.approvable-action',
    description: 'a synthetic requires-approval action, used only to exercise approve()/deny()',
    riskLevel: 'high',
    requiresApproval: true,
    allowedRoles: ['owner', 'admin'],
    inputSchema: lowRiskInputSchema,
    execute,
    summarizeResult: (result) => ({ recommendationId: result.id, state: result.state }),
  };
}

function makePendingRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    workspaceId: WORKSPACE_ID,
    customerId: CUSTOMER_ID,
    actorUserId: 'user_1',
    actorRole: 'owner',
    action: 'test.approvable-action',
    riskLevel: 'high',
    permissionDecision: 'permitted',
    approvalState: 'pending',
    executionStatus: 'blocked_approval',
    inputSummary: { recommendationId: RECOMMENDATION_ID },
    resultSummary: null,
    failureReason: null,
    correlationId: 'corr-1',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    decidedByUserId: null,
    decidedAt: null,
    ...overrides,
  };
}

/**
 * Fakes the two query shapes `approve()`/`deny()` need: a `select()` used by
 * `findRequestOrThrow` (returns each entry in `selectResults` in order, one
 * per call — lets a test simulate the row's state changing between two
 * sequential calls), and an `update()` whose first call is the
 * `pending`-guarded claim (chains `.returning()`, resolves to
 * `claimReturns`) and whose second call is the final status write (no
 * `.returning()`, just awaited directly).
 */
function makeApprovalDatabase(selectResults: Array<Record<string, unknown> | undefined>, claimReturns: boolean[] = [true]) {
  const limit = vi.fn();
  for (const row of selectResults) {
    limit.mockImplementationOnce(async () => (row ? [row] : []));
  }
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) }));

  const setCalls: Record<string, unknown>[] = [];
  const claimReturning = vi.fn();
  for (const claimed of claimReturns) {
    claimReturning.mockImplementationOnce(async () => (claimed ? [{ id: REQUEST_ID }] : []));
  }
  let updateCallIndex = 0;
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      updateCallIndex++;
      setCalls.push(values);
      // Odd calls are the `pending`-guarded claim (chains `.returning()`); even calls are the final status write (awaited directly, no `.returning()`).
      if (updateCallIndex % 2 === 1) {
        return { where: vi.fn(() => ({ returning: claimReturning })) };
      }
      return { where: vi.fn(async () => undefined) };
    }),
  }));

  const database = { client: { select, update } } as unknown as DatabaseService;
  return { database, setCalls };
}

describe('AiActionControlService', () => {
  it('executes a low-risk action for a permitted role and returns its result', async () => {
    const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
    const definition = makeLowRiskAction(execute);
    const service = makeService();

    const result = await ownerContext(() =>
      service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
    );

    expect(result).toEqual({ id: RECOMMENDATION_ID, state: 'dismissed' });
    expect(execute).toHaveBeenCalledWith({ recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID });
  });

  it('records an "executed" audit row for a successful action', async () => {
    const { database, insert, values } = makeDatabase();
    const definition = makeLowRiskAction(vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' })));
    const service = makeService({ database });

    await ownerContext(() =>
      service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
    );

    expect(insert).toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        actorUserId: 'user_1',
        actorRole: 'owner',
        action: 'recommendation.dismiss',
        riskLevel: 'low',
        permissionDecision: 'permitted',
        approvalState: 'not_required',
        executionStatus: 'executed',
        resultSummary: { recommendationId: RECOMMENDATION_ID, state: 'dismissed' },
        correlationId: 'corr-1',
      }),
    );
  });

  it('denies a role not in allowedRoles, never calling execute or reserving an idempotency key, and records blocked_permission', async () => {
    const { database, values } = makeDatabase();
    const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
    const definition = makeLowRiskAction(execute);
    const idempotency = makeIdempotency();
    const service = makeService({ database, idempotency });

    await expect(
      analystContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
      ),
    ).rejects.toThrow(UnauthorizedError);

    expect(execute).not.toHaveBeenCalled();
    expect(idempotency.reserve).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ permissionDecision: 'denied', executionStatus: 'blocked_permission', actorRole: 'analyst' }),
    );
  });

  it('rejects invalid input before checking permission or reserving an idempotency key, never calling execute', async () => {
    const { database, values } = makeDatabase();
    const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
    const definition = makeLowRiskAction(execute);
    const idempotency = makeIdempotency();
    const service = makeService({ database, idempotency });

    await expect(
      ownerContext(() =>
        service.execute(definition, { recommendationId: 'not-a-uuid' }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
      ),
    ).rejects.toThrow(ValidationError);

    expect(execute).not.toHaveBeenCalled();
    expect(idempotency.reserve).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ executionStatus: 'blocked_validation', failureReason: 'Invalid input.' }));
  });

  it('blocks a high-risk/requires-approval action before execution or reserving an idempotency key, and records blocked_approval', async () => {
    const { database, values } = makeDatabase();
    const definition = makeHighRiskAction();
    const idempotency = makeIdempotency();
    const service = makeService({ database, idempotency });

    await expect(
      ownerContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
      ),
    ).rejects.toThrow(ApprovalRequiredError);

    expect(definition.execute).not.toHaveBeenCalled();
    expect(idempotency.reserve).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'test.high-risk-action',
        riskLevel: 'high',
        permissionDecision: 'permitted',
        approvalState: 'pending',
        executionStatus: 'blocked_approval',
      }),
    );
  });

  it('propagates an execution failure, records executionStatus failed, and never marks the idempotency key complete', async () => {
    const { database, values } = makeDatabase();
    const idempotency = makeIdempotency();
    const definition = makeLowRiskAction(
      vi.fn(async () => {
        throw new Error('recommendation already dismissed');
      }),
    );
    const service = makeService({ database, idempotency });

    await expect(
      ownerContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
      ),
    ).rejects.toThrow('recommendation already dismissed');

    expect(idempotency.reserve).toHaveBeenCalledTimes(1);
    expect(idempotency.complete).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ executionStatus: 'failed', failureReason: 'recommendation already dismissed' }),
    );
  });

  it('never lets the model/input smuggle a different workspaceId — execute() always receives the caller-supplied context, not anything from rawInput', async () => {
    const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
    const definition = makeLowRiskAction(execute);
    const service = makeService();

    await ownerContext(() =>
      service.execute(
        definition,
        { recommendationId: RECOMMENDATION_ID, workspaceId: 'evil-workspace', customerId: 'evil-customer' },
        { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID },
        'key-1',
      ),
    );

    expect(execute).toHaveBeenCalledWith({ recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID });
  });

  it('consults the merchant policy boundary before executing (doc13/doc14 policy-check boundary)', async () => {
    const merchantKnowledge = makeMerchantKnowledge();
    const definition = makeLowRiskAction(vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' })));
    const service = makeService({ merchantKnowledge });

    await ownerContext(() =>
      service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
    );

    expect(merchantKnowledge.list).toHaveBeenCalledWith(WORKSPACE_ID, 'policy');
  });

  it('does not fail the request if the audit write fails, but logs it', async () => {
    const values = vi.fn(async () => {
      throw new Error('db down');
    });
    const database = { client: { insert: vi.fn(() => ({ values })) } } as unknown as DatabaseService;
    const logger = makeLogger();
    const definition = makeLowRiskAction(vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' })));
    const service = makeService({ database, logger });

    const result = await ownerContext(() =>
      service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
    );

    expect(result).toEqual({ id: RECOMMENDATION_ID, state: 'dismissed' });
    expect(logger.event).toHaveBeenCalledWith(
      'error',
      'Failed to record AI action audit',
      'AiActionControlService',
      expect.objectContaining({ errorType: 'Error' }),
    );
  });

  describe('idempotency (doc19 Phase 14 Slice 2)', () => {
    it('reserves the idempotency key only once execution is actually about to happen', async () => {
      const idempotency = makeIdempotency();
      const definition = makeLowRiskAction(vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' })));
      const service = makeService({ idempotency });

      await ownerContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
      );

      expect(idempotency.reserve).toHaveBeenCalledTimes(1);
      expect(idempotency.complete).toHaveBeenCalledTimes(1);
      // reserve() must resolve before complete() is ever called.
      const reserveOrder = (idempotency.reserve as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      const completeOrder = (idempotency.complete as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
      expect(reserveOrder).toBeLessThan(completeOrder);
    });

    it('does not execute the underlying action twice when retried with the same key', async () => {
      const idempotency = makeIdempotency({
        reserve: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      });
      const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
      const definition = makeLowRiskAction(execute);
      const service = makeService({ idempotency });

      await ownerContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
      );

      await expect(
        ownerContext(() =>
          service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
        ),
      ).rejects.toThrow(ConflictError);

      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('records a "duplicate" audit outcome for the retried request, distinct from the original "executed" row', async () => {
      const { database, values } = makeDatabase();
      const idempotency = makeIdempotency({
        reserve: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      });
      const definition = makeLowRiskAction(vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' })));
      const service = makeService({ database, idempotency });

      await ownerContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
      );
      await expect(
        ownerContext(() =>
          service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
        ),
      ).rejects.toThrow(ConflictError);

      expect(values).toHaveBeenNthCalledWith(1, expect.objectContaining({ executionStatus: 'executed' }));
      expect(values).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          executionStatus: 'duplicate',
          permissionDecision: 'permitted',
          approvalState: 'not_required',
          failureReason: 'This action was already requested with the same idempotency key.',
        }),
      );
    });

    it('permits a new intentional execution under a different key', async () => {
      const idempotency = makeIdempotency();
      const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
      const definition = makeLowRiskAction(execute);
      const service = makeService({ idempotency });

      await ownerContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-1'),
      );
      await ownerContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'key-2'),
      );

      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('cannot be bypassed across workspaces — the same raw key from two different workspaces reserves independently', async () => {
      const idempotency = makeIdempotency();
      const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
      const definition = makeLowRiskAction(execute);
      const service = makeService({ idempotency });

      await RequestContext.run(contextFor(WORKSPACE_ID, 'user_1'), () =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'shared-key'),
      );
      await RequestContext.run(contextFor(OTHER_WORKSPACE_ID, 'user_1'), () =>
        service.execute(
          definition,
          { recommendationId: RECOMMENDATION_ID },
          { workspaceId: OTHER_WORKSPACE_ID, customerId: CUSTOMER_ID },
          'shared-key',
        ),
      );

      // Both executions succeeded (neither was rejected as a duplicate of the other).
      expect(execute).toHaveBeenCalledTimes(2);
      const [firstKey, secondKey] = (idempotency.reserve as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0]);
      expect(firstKey).not.toBe(secondKey);
      expect(firstKey).toContain(WORKSPACE_ID);
      expect(secondKey).toContain(OTHER_WORKSPACE_ID);
    });

    it('never derives the idempotency key from workspaceId/action/input alone — two different raw keys never collide even for the identical request', async () => {
      const idempotency = makeIdempotency();
      const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
      const definition = makeLowRiskAction(execute);
      const service = makeService({ idempotency });

      await ownerContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'req-a'),
      );
      await ownerContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }, 'req-b'),
      );

      expect(execute).toHaveBeenCalledTimes(2);
    });
  });

  describe('listRecent', () => {
    it('queries ai_action_requests scoped to the given workspace', async () => {
      const limit = vi.fn(async () => []);
      const orderBy = vi.fn(() => ({ limit }));
      const where = vi.fn(() => ({ orderBy }));
      const from = vi.fn(() => ({ where }));
      const select = vi.fn(() => ({ from }));
      const database = { client: { select } } as unknown as DatabaseService;
      const service = makeService({ database });

      await service.listRecent(WORKSPACE_ID);

      expect(select).toHaveBeenCalled();
      expect(limit).toHaveBeenCalledWith(50);
    });
  });

  describe('approve/deny (doc19 Phase 14 Approval-Grant Workflow)', () => {
    it('approves a pending request, executes the action exactly once, and persists the final executed state', async () => {
      const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
      const definition = makeApprovableAction(execute);
      const registry = registryOf(definition);
      const pending = makePendingRequestRow();
      const { database, setCalls } = makeApprovalDatabase([pending]);
      const idempotency = makeIdempotency();
      const service = makeService({ database, idempotency, registry });

      await ownerContext(() => service.approve(REQUEST_ID, { workspaceId: WORKSPACE_ID }));

      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith({ recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID });
      expect(idempotency.reserve).toHaveBeenCalledWith(`ai-action-approval:${REQUEST_ID}`);

      // setCalls[0] is the pending -> approved claim, setCalls[1] is the final execution outcome.
      expect(setCalls[0]).toEqual(expect.objectContaining({ approvalState: 'approved', decidedByUserId: 'user_1' }));
      expect(setCalls[1]).toEqual(
        expect.objectContaining({
          executionStatus: 'executed',
          resultSummary: { recommendationId: RECOMMENDATION_ID, state: 'dismissed' },
          failureReason: null,
        }),
      );
    });

    it('denies a pending request without executing the action', async () => {
      const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
      const definition = makeApprovableAction(execute);
      const registry = registryOf(definition);
      const pending = makePendingRequestRow();
      const { database, setCalls } = makeApprovalDatabase([pending]);
      const idempotency = makeIdempotency();
      const service = makeService({ database, idempotency, registry });

      await ownerContext(() => service.deny(REQUEST_ID, { workspaceId: WORKSPACE_ID }));

      expect(execute).not.toHaveBeenCalled();
      expect(idempotency.reserve).not.toHaveBeenCalled();
      expect(setCalls[0]).toEqual(expect.objectContaining({ approvalState: 'denied', decidedByUserId: 'user_1' }));
    });

    it('rejects approving a request that is not pending, without touching idempotency', async () => {
      const definition = makeApprovableAction(vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' })));
      const registry = registryOf(definition);
      const decided = makePendingRequestRow({ approvalState: 'approved' });
      const { database } = makeApprovalDatabase([decided]);
      const idempotency = makeIdempotency();
      const service = makeService({ database, idempotency, registry });

      await expect(ownerContext(() => service.approve(REQUEST_ID, { workspaceId: WORKSPACE_ID }))).rejects.toThrow(ConflictError);

      expect(idempotency.reserve).not.toHaveBeenCalled();
    });

    it('rejects denying a request that is not pending, without touching idempotency', async () => {
      const decided = makePendingRequestRow({ approvalState: 'denied' });
      const { database } = makeApprovalDatabase([decided]);
      const idempotency = makeIdempotency();
      const service = makeService({ database, idempotency, registry: {} as ActionRegistry });

      await expect(ownerContext(() => service.deny(REQUEST_ID, { workspaceId: WORKSPACE_ID }))).rejects.toThrow(ConflictError);

      expect(idempotency.reserve).not.toHaveBeenCalled();
    });

    it('rejects approving a request from another workspace as NotFoundError, without touching idempotency', async () => {
      const { database } = makeApprovalDatabase([undefined]);
      const idempotency = makeIdempotency();
      const service = makeService({ database, idempotency, registry: {} as ActionRegistry });

      await expect(
        ownerContext(() => service.approve(REQUEST_ID, { workspaceId: OTHER_WORKSPACE_ID })),
      ).rejects.toThrow(NotFoundError);

      expect(idempotency.reserve).not.toHaveBeenCalled();
    });

    it('rejects denying a request from another workspace as NotFoundError', async () => {
      const { database } = makeApprovalDatabase([undefined]);
      const service = makeService({ database, registry: {} as ActionRegistry });

      await expect(
        ownerContext(() => service.deny(REQUEST_ID, { workspaceId: OTHER_WORKSPACE_ID })),
      ).rejects.toThrow(NotFoundError);
    });

    it('is safely rejected on a repeated approve — the second call sees the row already decided and never re-executes', async () => {
      const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
      const definition = makeApprovableAction(execute);
      const registry = registryOf(definition);
      const pending = makePendingRequestRow();
      const alreadyApproved = makePendingRequestRow({ approvalState: 'approved' });
      const { database } = makeApprovalDatabase([pending, alreadyApproved]);
      const idempotency = makeIdempotency();
      const service = makeService({ database, idempotency, registry });

      await ownerContext(() => service.approve(REQUEST_ID, { workspaceId: WORKSPACE_ID }));
      await expect(ownerContext(() => service.approve(REQUEST_ID, { workspaceId: WORKSPACE_ID }))).rejects.toThrow(ConflictError);

      expect(execute).toHaveBeenCalledTimes(1);
      expect(idempotency.reserve).toHaveBeenCalledTimes(1);
    });

    it('records a failed execution outcome and rethrows the original error, without completing the idempotency key', async () => {
      const execute = vi.fn(async () => {
        throw new Error('recommendation already dismissed');
      });
      const definition = makeApprovableAction(execute);
      const registry = registryOf(definition);
      const pending = makePendingRequestRow();
      const { database, setCalls } = makeApprovalDatabase([pending]);
      const idempotency = makeIdempotency();
      const service = makeService({ database, idempotency, registry });

      await expect(ownerContext(() => service.approve(REQUEST_ID, { workspaceId: WORKSPACE_ID }))).rejects.toThrow(
        'recommendation already dismissed',
      );

      expect(idempotency.complete).not.toHaveBeenCalled();
      expect(setCalls[1]).toEqual(
        expect.objectContaining({ executionStatus: 'failed', failureReason: 'recommendation already dismissed', resultSummary: null }),
      );
    });
  });
});
