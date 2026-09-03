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

/**
 * `triggerType`/`actionType` are not client-settable — `revenue_opportunity.created`
 * → `generate_recommendations` is the only wired pair today (see
 * automation-definitions schema's doc comment), so the server fixes both
 * rather than offering a choice with only one real answer.
 */
export const createAutomationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  conditions: automationConditionsSchema,
});

export type CreateAutomationInput = z.infer<typeof createAutomationSchema>;
