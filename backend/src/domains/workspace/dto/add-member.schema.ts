import { z } from 'zod';

/** Role catalog is fixed by doc 28 — not user-extensible. */
export const workspaceRoles = ['owner', 'admin', 'marketing', 'support', 'analyst'] as const;

export const addMemberSchema = z.object({
  userId: z.uuid(),
  role: z.enum(workspaceRoles),
});

export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type WorkspaceRole = (typeof workspaceRoles)[number];
