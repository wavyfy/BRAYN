import { z } from 'zod';
import { customerPreferenceCategories } from '../../../database/schema/customer-preferences';

const content = z.string().trim().min(1).max(2000);
const category = z.enum(customerPreferenceCategories);

/** Strict, same provenance rule as memory (`memory-entry.schema.ts`): only `merchant_provided` is ever accepted. */
export const createPreferenceSchema = z
  .object({
    category,
    content,
    provenance: z.literal('merchant_provided').optional(),
  })
  .strict();

export const updatePreferenceSchema = z
  .object({ category: category.optional(), content: content.optional() })
  .strict()
  .refine((value) => value.category !== undefined || value.content !== undefined, {
    message: 'At least one of category or content must be provided.',
  });

export type CreatePreferenceInput = z.infer<typeof createPreferenceSchema>;
export type UpdatePreferenceInput = z.infer<typeof updatePreferenceSchema>;
