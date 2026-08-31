import { SetMetadata } from '@nestjs/common';
import type { WorkspaceRole } from './dto/add-member.schema';

export const WORKSPACE_ROLES_KEY = 'workspaceRoles';

/**
 * Marks a route as workspace-membership-gated (doc 05/28 Authorization
 * flow: Authenticated User -> Workspace Membership -> Required Role).
 * Always requires the caller to have a membership in the `:workspaceId`
 * route param; passing roles further restricts to those roles (doc 28
 * Phase 1 Permission Matrix). No roles given = any member may proceed.
 *
 * Must be paired with `@UseGuards(WorkspaceMembershipGuard)` — this
 * decorator only attaches metadata, the guard reads it.
 */
export const RequireWorkspaceRole = (...roles: WorkspaceRole[]) => SetMetadata(WORKSPACE_ROLES_KEY, roles);
