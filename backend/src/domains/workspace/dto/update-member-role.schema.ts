import { z } from 'zod';
import { workspaceRoles } from './add-member.schema';

export const updateMemberRoleSchema = z.object({
  role: z.enum(workspaceRoles),
});

export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
