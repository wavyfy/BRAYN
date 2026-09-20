import { z } from 'zod';

export const askQuestionSchema = z.object({
  question: z.string().trim().min(1).max(2000),
  /** Doc19 Phase 12 step 2 — "Customer-aware questions". Omitted = step 1 basic-question behavior. */
  customerId: z.string().uuid().optional(),
});

export type AskQuestionInput = z.infer<typeof askQuestionSchema>;
