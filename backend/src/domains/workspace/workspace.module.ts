import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { WorkspaceMembershipController } from './workspace-membership.controller';
import { WorkspaceMembershipService } from './workspace-membership.service';
import { WorkspaceMembershipGuard } from './workspace-membership.guard';

/**
 * Owns: workspace, users, authentication, sessions, roles, permissions,
 * authorization, tenant isolation, approval policies.
 * See: "05. BRAYN Workspace, Identity & Permissions"
 *
 * Phase 2 part 1: workspace entity. Part 2: user entity. Part 3: workspace
 * membership — creator is auto-added as 'owner'. Part 4: WorkspaceMembershipGuard
 * (this change) centralizes the Authenticated User -> Workspace Membership ->
 * Required Role check (doc 05/28) that Parts 1/3 had inlined per-controller.
 * Fine-grained capability permissions (doc 28 Permission Categories) land later.
 */
@Module({
  controllers: [WorkspaceController, UserController, WorkspaceMembershipController],
  providers: [WorkspaceService, UserService, WorkspaceMembershipService, WorkspaceMembershipGuard],
  exports: [WorkspaceService, UserService, WorkspaceMembershipService],
})
export class WorkspaceModule {}
