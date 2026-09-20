import { describe, expect, it, vi } from 'vitest';
import { WriteToolsService } from './write-tools.service';
import { AiActionControlService } from '../ai-action-control/ai-action-control.service';
import {
  buildActionRegistry,
  RECOMMENDATION_DISMISS_ACTION,
  RECOMMENDATION_COMPLETE_ACTION,
  GENERATE_RECOMMENDATIONS_ACTION,
  type ActionRegistry,
} from '../ai-action-control/actions.registry';
import type { RecommendationService } from '../intelligence-engines/recommendation.service';
import { UnauthorizedError, ValidationError } from '../../common/errors/app-error';
import type { AiToolCall } from '../ai/ai-provider.interface';

const WORKSPACE_ID = 'ws_1';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const RECOMMENDATION_ID = '22222222-2222-4222-8222-222222222222';

/**
 * `buildActionRegistry`'s closures (`execute`) call into a real
 * RecommendationService — but WriteToolsService never invokes `definition.
 * execute` itself (only `AiActionControlService.execute()` may — that's the
 * enforcement boundary this suite exists to prove), so a real registry built
 * from an unused stub is safe: only `name`/`allowedRoles`/`description`/
 * `summarizeResult` are ever read directly by WriteToolsService.
 */
function makeRegistry(): ActionRegistry {
  return buildActionRegistry({} as RecommendationService);
}

function makeAiActionControl(overrides: { execute?: (...args: unknown[]) => Promise<unknown> } = {}): AiActionControlService {
  return {
    execute: vi.fn(overrides.execute ?? (async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }))),
  } as unknown as AiActionControlService;
}

function makeService(overrides: { registry?: ActionRegistry; aiActionControl?: AiActionControlService } = {}) {
  return new WriteToolsService(overrides.registry ?? makeRegistry(), overrides.aiActionControl ?? makeAiActionControl());
}

const dismissCall: AiToolCall = {
  id: 'call_1',
  name: RECOMMENDATION_DISMISS_ACTION,
  arguments: JSON.stringify({ recommendationId: RECOMMENDATION_ID, reason: 'No longer relevant' }),
};

const completeCall: AiToolCall = {
  id: 'call_2',
  name: RECOMMENDATION_COMPLETE_ACTION,
  arguments: JSON.stringify({ recommendationId: RECOMMENDATION_ID }),
};

describe('WriteToolsService', () => {
  describe('availableTools', () => {
    it('offers both dismiss and complete to an owner with a bound customerId', () => {
      const service = makeService();

      const tools = service.availableTools('owner', CUSTOMER_ID);

      expect(tools.map((t) => t.name).sort()).toEqual([RECOMMENDATION_COMPLETE_ACTION, RECOMMENDATION_DISMISS_ACTION].sort());
    });

    it('offers both tools to admin, marketing, and support — matching the registry\'s own allowedRoles for dismiss/complete', () => {
      const service = makeService();

      for (const role of ['admin', 'marketing', 'support']) {
        expect(service.availableTools(role, CUSTOMER_ID).map((t) => t.name).sort()).toEqual(
          [RECOMMENDATION_COMPLETE_ACTION, RECOMMENDATION_DISMISS_ACTION].sort(),
        );
      }
    });

    it('offers no tools to analyst — not in dismiss/complete allowedRoles', () => {
      const service = makeService();

      expect(service.availableTools('analyst', CUSTOMER_ID)).toEqual([]);
    });

    it('never offers generate_recommendations, even though it is a registered action', () => {
      const service = makeService();

      const names = service.availableTools('owner', CUSTOMER_ID).map((t) => t.name);
      expect(names).not.toContain(GENERATE_RECOMMENDATIONS_ACTION);
    });

    it('offers no tools when no customerId is bound, regardless of role', () => {
      const service = makeService();

      expect(service.availableTools('owner', undefined)).toEqual([]);
    });

    it('offers no tools for an undefined actor role', () => {
      const service = makeService();

      expect(service.availableTools(undefined, CUSTOMER_ID)).toEqual([]);
    });

    it('returns the exact input schema for each tool, matching the registry action it fronts', () => {
      const service = makeService();

      const tools = service.availableTools('owner', CUSTOMER_ID);
      const dismiss = tools.find((t) => t.name === RECOMMENDATION_DISMISS_ACTION)!;
      const complete = tools.find((t) => t.name === RECOMMENDATION_COMPLETE_ACTION)!;

      expect(dismiss.parameters).toEqual({
        type: 'object',
        properties: {
          recommendationId: { type: 'string', description: 'The id of the recommendation to dismiss.' },
          reason: { type: 'string', description: 'Optional reason the recommendation no longer applies.' },
        },
        required: ['recommendationId'],
        additionalProperties: false,
      });
      expect(complete.parameters).toEqual({
        type: 'object',
        properties: { recommendationId: { type: 'string', description: 'The id of the recommendation to mark completed.' } },
        required: ['recommendationId'],
        additionalProperties: false,
      });
    });
  });

  describe('isWriteTool', () => {
    it('recognizes both registered write tools', () => {
      const service = makeService();

      expect(service.isWriteTool(RECOMMENDATION_DISMISS_ACTION)).toBe(true);
      expect(service.isWriteTool(RECOMMENDATION_COMPLETE_ACTION)).toBe(true);
    });

    it('does not claim generate_recommendations — a registered action, but not a write tool this service fronts', () => {
      const service = makeService();

      expect(service.isWriteTool(GENERATE_RECOMMENDATIONS_ACTION)).toBe(false);
    });

    it('does not claim an unrelated tool name', () => {
      const service = makeService();

      expect(service.isWriteTool('get_customer_activity_history')).toBe(false);
      expect(service.isWriteTool('not_a_real_tool')).toBe(false);
    });
  });

  describe('execute — routing and the AI Action Control enforcement boundary', () => {
    it('rejects an unknown tool name without ever calling AiActionControlService', async () => {
      const aiActionControl = makeAiActionControl();
      const service = makeService({ aiActionControl });

      await expect(service.execute({ id: 'c', name: 'not_a_real_tool', arguments: '{}' }, WORKSPACE_ID, CUSTOMER_ID)).rejects.toThrow(
        ValidationError,
      );
      expect(aiActionControl.execute).not.toHaveBeenCalled();
    });

    it('rejects generate_recommendations — a real registered action, but routed only through Automation, never this tool surface', async () => {
      const aiActionControl = makeAiActionControl();
      const service = makeService({ aiActionControl });

      await expect(
        service.execute({ id: 'c', name: GENERATE_RECOMMENDATIONS_ACTION, arguments: '{}' }, WORKSPACE_ID, CUSTOMER_ID),
      ).rejects.toThrow(ValidationError);
      expect(aiActionControl.execute).not.toHaveBeenCalled();
    });

    it('routes a dismiss call through AiActionControlService.execute() — never RecommendationService directly', async () => {
      const registry = makeRegistry();
      const aiActionControl = makeAiActionControl();
      const service = makeService({ registry, aiActionControl });

      await service.execute(dismissCall, WORKSPACE_ID, CUSTOMER_ID);

      expect(aiActionControl.execute).toHaveBeenCalledTimes(1);
      expect(aiActionControl.execute).toHaveBeenCalledWith(
        registry.dismiss,
        { recommendationId: RECOMMENDATION_ID, reason: 'No longer relevant' },
        { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID },
        'ai-tool-call:call_1',
      );
    });

    it('routes a complete call through AiActionControlService.execute() with the complete action definition', async () => {
      const registry = makeRegistry();
      const aiActionControl = makeAiActionControl({ execute: async () => ({ id: RECOMMENDATION_ID, state: 'completed' }) });
      const service = makeService({ registry, aiActionControl });

      await service.execute(completeCall, WORKSPACE_ID, CUSTOMER_ID);

      expect(aiActionControl.execute).toHaveBeenCalledTimes(1);
      expect(aiActionControl.execute).toHaveBeenCalledWith(
        registry.complete,
        { recommendationId: RECOMMENDATION_ID },
        { workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID },
        'ai-tool-call:call_2',
      );
    });

    it('never passes caller-controllable workspaceId/customerId from call.arguments — only the bound context', async () => {
      const aiActionControl = makeAiActionControl();
      const service = makeService({ aiActionControl });
      const call: AiToolCall = {
        id: 'call_3',
        name: RECOMMENDATION_DISMISS_ACTION,
        arguments: JSON.stringify({ recommendationId: RECOMMENDATION_ID, workspaceId: 'evil', customerId: 'evil' }),
      };

      await service.execute(call, WORKSPACE_ID, CUSTOMER_ID);

      const [, , context] = (aiActionControl.execute as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(context).toEqual({ workspaceId: WORKSPACE_ID, customerId: CUSTOMER_ID });
    });

    it('propagates AiActionControlService.execute()\'s own rejection unchanged — never swallows or wraps it', async () => {
      const aiActionControl = makeAiActionControl({
        execute: async () => {
          throw new UnauthorizedError('Your role does not permit the action "recommendation.dismiss".');
        },
      });
      const service = makeService({ aiActionControl });

      await expect(service.execute(dismissCall, WORKSPACE_ID, CUSTOMER_ID)).rejects.toThrow(UnauthorizedError);
    });
  });

  describe('execute — idempotency key derivation', () => {
    it('derives the idempotency key from call.id, never from call.arguments content', async () => {
      const aiActionControl = makeAiActionControl();
      const service = makeService({ aiActionControl });
      const sameArgsDifferentCallId: AiToolCall = { ...dismissCall, id: 'call_different' };

      await service.execute(sameArgsDifferentCallId, WORKSPACE_ID, CUSTOMER_ID);

      const [, , , idempotencyKey] = (aiActionControl.execute as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(idempotencyKey).toBe('ai-tool-call:call_different');
    });

    it('reuses the same idempotency key for the same call.id even if arguments differ, matching a genuine low-level retry', async () => {
      const aiActionControl = makeAiActionControl();
      const service = makeService({ aiActionControl });
      const retriedCall: AiToolCall = { id: 'call_1', name: RECOMMENDATION_DISMISS_ACTION, arguments: JSON.stringify({ recommendationId: RECOMMENDATION_ID }) };

      await service.execute(dismissCall, WORKSPACE_ID, CUSTOMER_ID);
      await service.execute(retriedCall, WORKSPACE_ID, CUSTOMER_ID);

      const calls = (aiActionControl.execute as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][3]).toBe('ai-tool-call:call_1');
      expect(calls[1][3]).toBe('ai-tool-call:call_1');
    });
  });

  describe('execute — malformed arguments', () => {
    it('rejects invalid JSON in call.arguments without calling AiActionControlService', async () => {
      const aiActionControl = makeAiActionControl();
      const service = makeService({ aiActionControl });
      const call: AiToolCall = { id: 'call_1', name: RECOMMENDATION_DISMISS_ACTION, arguments: 'not json' };

      await expect(service.execute(call, WORKSPACE_ID, CUSTOMER_ID)).rejects.toThrow(ValidationError);
      expect(aiActionControl.execute).not.toHaveBeenCalled();
    });

    it('rejects empty-string arguments the same way', async () => {
      const aiActionControl = makeAiActionControl();
      const service = makeService({ aiActionControl });
      const call: AiToolCall = { id: 'call_1', name: RECOMMENDATION_COMPLETE_ACTION, arguments: '' };

      await expect(service.execute(call, WORKSPACE_ID, CUSTOMER_ID)).rejects.toThrow(ValidationError);
      expect(aiActionControl.execute).not.toHaveBeenCalled();
    });
  });

  describe('execute — action-result accuracy', () => {
    it('returns dismiss\'s result summarized exactly as the registry\'s own summarizeResult defines', async () => {
      const registry = makeRegistry();
      const aiActionControl = makeAiActionControl({ execute: async () => ({ id: RECOMMENDATION_ID, state: 'dismissed' }) });
      const service = makeService({ registry, aiActionControl });

      const output = await service.execute(dismissCall, WORKSPACE_ID, CUSTOMER_ID);

      expect(JSON.parse(output)).toEqual({ recommendationId: RECOMMENDATION_ID, state: 'dismissed' });
    });

    it('returns complete\'s result summarized exactly as the registry\'s own summarizeResult defines', async () => {
      const registry = makeRegistry();
      const aiActionControl = makeAiActionControl({ execute: async () => ({ id: RECOMMENDATION_ID, state: 'completed' }) });
      const service = makeService({ registry, aiActionControl });

      const output = await service.execute(completeCall, WORKSPACE_ID, CUSTOMER_ID);

      expect(JSON.parse(output)).toEqual({ recommendationId: RECOMMENDATION_ID, state: 'completed' });
    });

    it('reports the actual execution result, not a claimed/assumed one — different result payload produces a different summary', async () => {
      const otherRecommendationId = '33333333-3333-4333-8333-333333333333';
      const aiActionControl = makeAiActionControl({ execute: async () => ({ id: otherRecommendationId, state: 'dismissed' }) });
      const service = makeService({ aiActionControl });

      const output = await service.execute(dismissCall, WORKSPACE_ID, CUSTOMER_ID);

      expect(JSON.parse(output)).toEqual({ recommendationId: otherRecommendationId, state: 'dismissed' });
    });
  });
});
