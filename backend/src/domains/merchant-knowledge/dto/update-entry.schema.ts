import { z } from 'zod';

export const updateEntrySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().trim().min(1).max(10000).optional(),
  })
  .refine((value) => value.title !== undefined || value.content !== undefined, {
    message: 'At least one of title or content must be provided.',
  });

export type UpdateEntryInput = z.infer<typeof updateEntrySchema>;
