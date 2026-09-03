import { z } from 'zod';

/** Doc13 — "Knowledge" (AI can use to understand the business) vs "Policy" (constrains what AI/automation should do). */
export const merchantKnowledgeEntryTypes = ['knowledge', 'policy'] as const;

export const createEntrySchema = z.object({
  type: z.enum(merchantKnowledgeEntryTypes),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(10000),
});

export type CreateEntryInput = z.infer<typeof createEntrySchema>;
