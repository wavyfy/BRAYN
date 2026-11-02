import { z } from 'zod';

/** Mirrors RevenueOpportunityService's `OpportunityPriority`/`OpportunityType` — the only condition inputs available today. */
const opportunityPriorities = ['critical', 'high', 'medium', 'low'] as const;
/** Every type the Revenue Opportunity Detector produces (`OpportunityType`). */
export const opportunityTypes = ['reorder', 'win_back', 'vip_recognition', 'cross_sell', 'upsell', 'bundle'] as const;

export const automationConditionsSchema = z
  .object({
    priorityIn: z.array(z.enum(opportunityPriorities)).min(1).optional(),
    typeIn: z.array(z.enum(opportunityTypes)).min(1).optional(),
  })
  .optional();

/** The only two real trigger types wired today (see automation-definitions schema's doc comment). */
const automationTriggerTypes = ['revenue_opportunity.created', 'customer_health.recalculated'] as const;

/** Actions an automation may run (see automation-definitions schema's doc comment). */
export const automationActionTypes = ['generate_recommendations', 'internal_notification.create'] as const;

/**
 * `triggerType` and `actionType` default to the original pair for callers
 * that don't set them, preserving existing behavior exactly.
 * `internal_notification.create` needs a triggering opportunity, so it is
 * only valid with `revenue_opportunity.created` (#9 decision, Nov 2, 2026).
 */
export const createAutomationSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    triggerType: z.enum(automationTriggerTypes).default('revenue_opportunity.created'),
    actionType: z.enum(automationActionTypes).default('generate_recommendations'),
    conditions: automationConditionsSchema,
  })
  .refine((value) => !(value.actionType === 'internal_notification.create' && value.triggerType !== 'revenue_opportunity.created'), {
    message: 'Internal notifications can only be triggered by a new revenue opportunity.',
    path: ['actionType'],
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
