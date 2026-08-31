import { z } from 'zod';

export const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(200),
});

export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
