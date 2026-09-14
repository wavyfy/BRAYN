import { z } from 'zod';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import type { ActionDefinition } from './action-definition';

/**
 * Doc19 Phase 14 Slice 1's original two registered actions — locked
 * decision: `RecommendationService.dismiss()`/`.complete()`, chosen
 * specifically because they're low-risk, internal state-transition writes
 * with no external side effect (no customer contact, no money, no
 * commerce write).
 *
 * Role list mirrors doc28's Phase 1 Permission Matrix "AI action
 * execution" row as-is (Owner Full, Admin Manage, Marketing/Support
 * Permitted, Analyst not permitted) — not a newly invented policy.
 *
 * `generate_recommendations` (doc19 Phase 15 item 7) joined this registry
 * once AI Action Control existed for it to integrate with — previously
 * called directly by `AutomationService`, bypassing this enforcement
 * point entirely (see `automation-definitions` schema's older doc
 * comment). It is only ever invoked through
 * `AiActionControlService.executeForAutomation()` — the existing manual
 * "Generate recommendations" button (`RecommendationController`) is a
 * separate, human-initiated path and stays untouched; AI Action Control
 * governs AI/automation-initiated actions (doc03 rule 6/7), not a
 * merchant's own direct action.
 */
const dismissInputSchema = z.object({
  recommendationId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

const completeInputSchema = z.object({
  recommendationId: z.string().uuid(),
});

/** No fields — `canonicalCustomerId` comes from `context.customerId`, same convention as dismiss/complete, never from caller-supplied input (doc03 rule 3). */
const generateRecommendationsInputSchema = z.object({});

export const RECOMMENDATION_DISMISS_ACTION = 'recommendation.dismiss';
export const RECOMMENDATION_COMPLETE_ACTION = 'recommendation.complete';
export const GENERATE_RECOMMENDATIONS_ACTION = 'generate_recommendations';

/**
 * Defined here (not in `ai-action-control.module.ts`) so both the module
 * and `AiActionControlService` can import it without a module<->service
 * circular import — the module still re-exports it unchanged for existing
 * importers (e.g. `WriteToolsService`).
 */
export const ACTION_REGISTRY = Symbol('ACTION_REGISTRY');

export function buildActionRegistry(recommendationService: RecommendationService) {
  const dismiss: ActionDefinition<z.infer<typeof dismissInputSchema>, Awaited<ReturnType<RecommendationService['dismiss']>>> = {
    name: RECOMMENDATION_DISMISS_ACTION,
    description: 'Dismiss an active recommendation for a customer.',
    riskLevel: 'low',
    requiresApproval: false,
    allowedRoles: ['owner', 'admin', 'marketing', 'support'],
    inputSchema: dismissInputSchema,
    execute: (input, context) => recommendationService.dismiss(context.workspaceId, context.customerId!, input.recommendationId, input.reason),
    summarizeResult: (result) => ({ recommendationId: result?.id, state: result?.state }),
  };

  const complete: ActionDefinition<z.infer<typeof completeInputSchema>, Awaited<ReturnType<RecommendationService['complete']>>> = {
    name: RECOMMENDATION_COMPLETE_ACTION,
    description: 'Mark an active recommendation as completed for a customer.',
    riskLevel: 'low',
    requiresApproval: false,
    allowedRoles: ['owner', 'admin', 'marketing', 'support'],
    inputSchema: completeInputSchema,
    execute: (input, context) => recommendationService.complete(context.workspaceId, context.customerId!, input.recommendationId),
    summarizeResult: (result) => ({ recommendationId: result?.id, state: result?.state }),
  };

  /** Same low-risk classification as dismiss/complete (doc14 — "writes recommendations rows, the same effect a merchant can already trigger by hand"); `allowedRoles` mirrors doc28's "Business Action Automation" row (Owner Full, Admin/Marketing Manage) for completeness, though `executeForAutomation()` never checks it — there is no human actor on this path to check a role against. */
  const generateRecommendations: ActionDefinition<z.infer<typeof generateRecommendationsInputSchema>, Awaited<ReturnType<RecommendationService['generate']>>> = {
    name: GENERATE_RECOMMENDATIONS_ACTION,
    description: 'Generate new recommendations for a customer from their current open revenue opportunities.',
    riskLevel: 'low',
    requiresApproval: false,
    allowedRoles: ['owner', 'admin', 'marketing'],
    inputSchema: generateRecommendationsInputSchema,
    execute: (_input, context) => recommendationService.generate(context.workspaceId, context.customerId!),
    summarizeResult: (result) => ({ recommendationsCount: result.length }),
  };

  return { dismiss, complete, generateRecommendations };
}

export type ActionRegistry = ReturnType<typeof buildActionRegistry>;

/** Doc19 Phase 14 Approval-Grant Workflow — `AiActionControlService.approve()`/`deny()` only have a stored action-name string (`aiActionRequests.action`) to resume from, not a typed reference; this resolves it back to the registered `ActionDefinition`. */
export function findActionByName(registry: ActionRegistry, name: string): ActionDefinition<unknown, unknown> | undefined {
  return Object.values(registry).find((definition) => definition.name === name) as ActionDefinition<unknown, unknown> | undefined;
}
