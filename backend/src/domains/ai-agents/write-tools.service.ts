import { Inject, Injectable } from '@nestjs/common';
import { AiActionControlService } from '../ai-action-control/ai-action-control.service';
import { ACTION_REGISTRY } from '../ai-action-control/ai-action-control.module';
import type { ActionRegistry } from '../ai-action-control/actions.registry';
import { RECOMMENDATION_COMPLETE_ACTION, RECOMMENDATION_DISMISS_ACTION } from '../ai-action-control/actions.registry';
import type { ActionExecutionContext } from '../ai-action-control/action-definition';
import { ValidationError } from '../../common/errors/app-error';
import type { WorkspaceRole } from '../workspace/dto/add-member.schema';
import type { AiToolCall, AiToolDefinition } from '../ai/ai-provider.interface';

const DISMISS_PARAMETERS = {
  type: 'object',
  properties: {
    recommendationId: { type: 'string', description: 'The id of the recommendation to dismiss.' },
    reason: { type: 'string', description: 'Optional reason the recommendation no longer applies.' },
  },
  required: ['recommendationId'],
  additionalProperties: false,
};

const COMPLETE_PARAMETERS = {
  type: 'object',
  properties: {
    recommendationId: { type: 'string', description: 'The id of the recommendation to mark completed.' },
  },
  required: ['recommendationId'],
  additionalProperties: false,
};

/**
 * Doc19 Phase 12 step 7 — "Controlled write tools". Exposes the two
 * `ActionDefinition`s already registered by Phase 14 Slice 1
 * (`actions.registry.ts`) as AI-callable tools, mirroring
 * `ReadToolsService`'s exact shape. This adds no business logic — every
 * write still happens only inside `RecommendationService`, reached only
 * through `AiActionControlService.execute()` (doc14 Tool Execution Flow —
 * Input Validation -> Permission/Policy -> AI Action Control -> Approval if
 * Required -> Execution -> Audit, all already built and unchanged here).
 *
 * Tool input schemas expose only the real business fields
 * (`recommendationId`, `reason`) — never `workspaceId`, actor identity, or
 * an idempotency key (doc28 Tenant Isolation; doc03 rule 3). `workspaceId`/
 * `customerId` are bound from the caller's already-authenticated context,
 * exactly like `ReadToolsService`.
 *
 * Idempotency key: `ai-tool-call:${call.id}`. `call.id` is the tool-call
 * identifier the provider's function-calling protocol assigns to this
 * specific invocation — it is never part of the model's own `arguments`
 * content, so the model cannot choose or influence it. This mirrors the
 * existing precedent in `WebhookIngestService` (`webhook:${integration.id}:
 * ${parsed.externalEventId}` — an external-but-infra-assigned identifier,
 * not something WebhookIngestService invents from request content):
 * a genuine low-level retry of the same tool invocation keeps the same
 * `call.id` (same key, `AiActionControlService` de-dupes it); a genuinely
 * new decision by the model produces a new `call.id` (new key, permitted).
 * Never derived from workspaceId/action/input (doc19 Phase 14 Slice 2).
 */
@Injectable()
export class WriteToolsService {
  constructor(
    @Inject(ACTION_REGISTRY) private readonly registry: ActionRegistry,
    private readonly aiActionControl: AiActionControlService,
  ) {}

  /** Mirrors `ReadToolsService.availableTools` — which tools are even offered is decided here, per-action, from the action's own `allowedRoles` (no duplicated role list). */
  availableTools(actorRole: string | undefined, customerId: string | undefined): AiToolDefinition[] {
    if (!actorRole || !customerId) {
      return [];
    }

    const tools: AiToolDefinition[] = [];
    if (this.registry.dismiss.allowedRoles.includes(actorRole as WorkspaceRole)) {
      tools.push({ name: RECOMMENDATION_DISMISS_ACTION, description: this.registry.dismiss.description, parameters: DISMISS_PARAMETERS });
    }
    if (this.registry.complete.allowedRoles.includes(actorRole as WorkspaceRole)) {
      tools.push({ name: RECOMMENDATION_COMPLETE_ACTION, description: this.registry.complete.description, parameters: COMPLETE_PARAMETERS });
    }
    return tools;
  }

  /** Lets `MerchantBusinessAnalystService` route a tool call to this service vs. `ReadToolsService` without duplicating tool-name constants. */
  isWriteTool(name: string): boolean {
    return name === RECOMMENDATION_DISMISS_ACTION || name === RECOMMENDATION_COMPLETE_ACTION;
  }

  /** Every write goes through `AiActionControlService.execute()` — never `RecommendationService` directly (doc03 rule 7 — one enforcement point). */
  async execute(call: AiToolCall, workspaceId: string, customerId: string): Promise<string> {
    if (call.name !== RECOMMENDATION_DISMISS_ACTION && call.name !== RECOMMENDATION_COMPLETE_ACTION) {
      throw new ValidationError(`Unknown tool "${call.name}".`);
    }

    const idempotencyKey = `ai-tool-call:${call.id}`;
    const context: ActionExecutionContext = { workspaceId, customerId };
    const rawInput = this.parseArguments(call);

    if (call.name === RECOMMENDATION_DISMISS_ACTION) {
      const result = await this.aiActionControl.execute(this.registry.dismiss, rawInput, context, idempotencyKey);
      return JSON.stringify(this.registry.dismiss.summarizeResult?.(result) ?? { success: true });
    }

    const result = await this.aiActionControl.execute(this.registry.complete, rawInput, context, idempotencyKey);
    return JSON.stringify(this.registry.complete.summarizeResult?.(result) ?? { success: true });
  }

  private parseArguments(call: AiToolCall): unknown {
    try {
      return JSON.parse(call.arguments);
    } catch {
      throw new ValidationError(`Invalid arguments for tool "${call.name}".`);
    }
  }
}
