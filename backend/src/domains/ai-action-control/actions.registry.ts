import { z } from 'zod';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import type { ActionDefinition } from './action-definition';

/**
 * Doc19 Phase 14 Slice 1's only two registered actions — locked decision:
 * `RecommendationService.dismiss()`/`.complete()`, chosen specifically
 * because they're low-risk, internal state-transition writes with no
 * external side effect (no customer contact, no money, no commerce write).
 * `generate_recommendations` is deliberately NOT registered here — it's
 * Business Action Automation's existing low-risk action (see
 * `automation-definitions` schema's doc comment), not this slice's.
 *
 * Role list mirrors doc28's Phase 1 Permission Matrix "AI action
 * execution" row as-is (Owner Full, Admin Manage, Marketing/Support
 * Permitted, Analyst not permitted) — not a newly invented policy.
 */
const dismissInputSchema = z.object({
  recommendationId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});

const completeInputSchema = z.object({
  recommendationId: z.string().uuid(),
});

export const RECOMMENDATION_DISMISS_ACTION = 'recommendation.dismiss';
export const RECOMMENDATION_COMPLETE_ACTION = 'recommendation.complete';

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

  return { dismiss, complete };
}

export type ActionRegistry = ReturnType<typeof buildActionRegistry>;
