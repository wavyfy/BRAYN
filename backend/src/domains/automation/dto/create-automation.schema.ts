import { z } from 'zod';

/** Mirrors RevenueOpportunityService's `OpportunityPriority`/`OpportunityType` — the only condition inputs available today. */
const opportunityPriorities = ['critical', 'high', 'medium', 'low'] as const;
const opportunityTypes = ['reorder', 'win_back', 'vip_recognition'] as const;

export const automationConditionsSchema = z
  .object({
    priorityIn: z.array(z.enum(opportunityPriorities)).min(1).optional(),
    typeIn: z.array(z.enum(opportunityTypes)).min(1).optional(),
  })
  .optional();

/** The only two real trigger types wired today (see automation-definitions schema's doc comment). */
const automationTriggerTypes = ['revenue_opportunity.created', 'customer_health.recalculated'] as const;

/**
 * `actionType` is not client-settable — `generate_recommendations` is the
 * only wired action today (see automation-definitions schema's doc
 * comment), so the server fixes it rather than offering a choice with
 * only one real answer. `triggerType` defaults to the original (and
 * still most common) pair for callers that don't set it, preserving
 * existing behavior exactly.
 */
export const createAutomationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  triggerType: z.enum(automationTriggerTypes).default('revenue_opportunity.created'),
  conditions: automationConditionsSchema,
});

/**
 * `z.input`, not `z.infer`/`z.output` — `triggerType` must stay optional
 * on this type since `.default(...)` only resolves it during an actual
 * `.parse()` (the ZodValidationPipe boundary); a caller that constructs
 * this object directly (every existing service-level test, and any
 * future direct `AutomationService.create()` caller) still needs to be
 * able to omit it, exactly as before this field existed.
 */
export type CreateAutomationInput = z.input<typeof createAutomationSchema>;
