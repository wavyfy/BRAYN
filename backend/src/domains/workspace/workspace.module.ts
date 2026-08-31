import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { WorkspaceMembershipController } from './workspace-membership.controller';
import { WorkspaceMembershipService } from './workspace-membership.service';

/**
 * Owns: workspace, users, authentication, sessions, roles, permissions,
 * authorization, tenant isolation, approval policies.
 * See: "05. BRAYN Workspace, Identity & Permissions"
 *
 * Phase 2 part 1: workspace entity. Part 2: user entity. Part 3: workspace
 * membership (this change) — creator is auto-added as 'owner'. Roles as a
 * distinct enforcement layer / permissions land in later parts.
 */
@Module({
  controllers: [WorkspaceController, UserController, WorkspaceMembershipController],
  providers: [WorkspaceService, UserService, WorkspaceMembershipService],
  exports: [WorkspaceService, UserService, WorkspaceMembershipService],
})
export class WorkspaceModule {}
