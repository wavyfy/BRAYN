import { z } from 'zod';

const content = z.string().trim().min(1).max(5000);

/**
 * Strict: a client can never pick a provenance other than
 * `merchant_provided` (doc08 — uncertain inference must not silently become
 * verified fact). The service sets provenance itself; the optional field is
 * only accepted so an explicit `merchant_provided` isn't rejected.
 */
export const createMemoryEntrySchema = z
  .object({
    content,
    provenance: z.literal('merchant_provided').optional(),
  })
  .strict();

export const updateMemoryEntrySchema = z.object({ content }).strict();

export type CreateMemoryEntryInput = z.infer<typeof createMemoryEntrySchema>;
export type UpdateMemoryEntryInput = z.infer<typeof updateMemoryEntrySchema>;
