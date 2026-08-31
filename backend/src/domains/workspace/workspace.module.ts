import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { UserController } from './user.controller';
import { UserService } from './user.service';

/**
 * Owns: workspace, users, authentication, sessions, roles, permissions,
 * authorization, tenant isolation, approval policies.
 * See: "05. BRAYN Workspace, Identity & Permissions"
 *
 * Phase 2 part 1: workspace entity. Part 2: user entity (this change).
 * Workspace membership/roles/permissions land in later parts.
 */
@Module({
  controllers: [WorkspaceController, UserController],
  providers: [WorkspaceService, UserService],
  exports: [WorkspaceService, UserService],
})
export class WorkspaceModule {}
