import { z } from 'zod';
import { automationConditionsSchema } from './create-automation.schema';

export const updateAutomationSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    conditions: automationConditionsSchema,
    enabled: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.conditions !== undefined || value.enabled !== undefined, {
    message: 'At least one of name, conditions, or enabled must be provided.',
  });

export type UpdateAutomationInput = z.infer<typeof updateAutomationSchema>;
