import { z } from 'zod';

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(200),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
