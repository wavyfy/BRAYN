import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiActionControlService } from './ai-action-control.service';
import { RequestContext } from '../../common/logging/request-context';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { DatabaseService } from '../../database/database.service';
import { MerchantKnowledgeService } from '../merchant-knowledge/merchant-knowledge.service';
import { ApprovalRequiredError, UnauthorizedError, ValidationError } from '../../common/errors/app-error';
import type { ActionDefinition } from './action-definition';

const WORKSPACE_ID = 'ws_1';
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

function makeLogger(): StructuredLoggerService {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

function makeService(overrides: {
  database?: DatabaseService;
  merchantKnowledge?: MerchantKnowledgeService;
  logger?: StructuredLoggerService;
} = {}) {
  return new AiActionControlService(
    overrides.database ?? makeDatabase().database,
    overrides.merchantKnowledge ?? makeMerchantKnowledge(),
    overrides.logger ?? makeLogger(),
  );
}

function ownerContext<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { correlationId: 'corr-1', userId: 'clerk_1', workspaceId: WORKSPACE_ID, actorUserId: 'user_1', actorRole: 'owner' },
    fn,
  );
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

describe('AiActionControlService', () => {
  it('executes a low-risk action for a permitted role and returns its result', async () => {
    const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
    const definition = makeLowRiskAction(execute);
    const service = makeService();

    const result = await ownerContext(() =>
      service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }),
    );

    expect(result).toEqual({ id: RECOMMENDATION_ID, state: 'dismissed' });
    expect(execute).toHaveBeenCalledWith({ recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID });
  });

  it('records an "executed" audit row for a successful action', async () => {
    const { database, insert, values } = makeDatabase();
    const definition = makeLowRiskAction(vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' })));
    const service = makeService({ database });

    await ownerContext(() =>
      service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }),
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

  it('denies a role not in allowedRoles, never calling execute, and records blocked_permission', async () => {
    const { database, values } = makeDatabase();
    const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
    const definition = makeLowRiskAction(execute);
    const service = makeService({ database });

    await expect(
      analystContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }),
      ),
    ).rejects.toThrow(UnauthorizedError);

    expect(execute).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ permissionDecision: 'denied', executionStatus: 'blocked_permission', actorRole: 'analyst' }),
    );
  });

  it('rejects invalid input before checking permission, never calling execute', async () => {
    const { database, values } = makeDatabase();
    const execute = vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }));
    const definition = makeLowRiskAction(execute);
    const service = makeService({ database });

    await expect(
      ownerContext(() => service.execute(definition, { recommendationId: 'not-a-uuid' }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID })),
    ).rejects.toThrow(ValidationError);

    expect(execute).not.toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ executionStatus: 'blocked_validation', failureReason: 'Invalid input.' }));
  });

  it('blocks a high-risk/requires-approval action before execution, and records blocked_approval', async () => {
    const { database, values } = makeDatabase();
    const definition = makeHighRiskAction();
    const service = makeService({ database });

    await expect(
      ownerContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }),
      ),
    ).rejects.toThrow(ApprovalRequiredError);

    expect(definition.execute).not.toHaveBeenCalled();
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

  it('propagates an execution failure and records executionStatus failed with the error message', async () => {
    const { database, values } = makeDatabase();
    const definition = makeLowRiskAction(
      vi.fn(async () => {
        throw new Error('recommendation already dismissed');
      }),
    );
    const service = makeService({ database });

    await expect(
      ownerContext(() =>
        service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }),
      ),
    ).rejects.toThrow('recommendation already dismissed');

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
      ),
    );

    expect(execute).toHaveBeenCalledWith({ recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID });
  });

  it('consults the merchant policy boundary before executing (doc13/doc14 policy-check boundary)', async () => {
    const merchantKnowledge = makeMerchantKnowledge();
    const definition = makeLowRiskAction(vi.fn(async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' })));
    const service = makeService({ merchantKnowledge });

    await ownerContext(() =>
      service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }),
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
      service.execute(definition, { recommendationId: RECOMMENDATION_ID }, { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID }),
    );

    expect(result).toEqual({ id: RECOMMENDATION_ID, state: 'dismissed' });
    expect(logger.event).toHaveBeenCalledWith(
      'error',
      'Failed to record AI action audit',
      'AiActionControlService',
      expect.objectContaining({ errorType: 'Error' }),
    );
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
});
