import { Module } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';

/**
 * Owns: workspace, users, authentication, sessions, roles, permissions,
 * authorization, tenant isolation, approval policies.
 * See: "05. BRAYN Workspace, Identity & Permissions"
 *
 * Phase 2 part 1: workspace entity only. Users/roles/permissions land in
 * later parts of this same phase.
 */
@Module({
  controllers: [WorkspaceController],
  providers: [WorkspaceService],
  exports: [WorkspaceService],
})
export class WorkspaceModule {}
