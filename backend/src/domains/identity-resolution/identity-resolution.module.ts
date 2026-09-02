import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { IdentityResolutionService } from './identity-resolution.service';
import { IdentityResolutionController } from './identity-resolution.controller';

/**
 * Owns: identity matching, identity linking, anonymous → known identity,
 * deduplication, customer merging, source identity mapping.
 * See: "09. BRAYN Identity Resolution & Customer Data"
 *
 * Deterministic email matching + phone-based duplicate detection (no
 * merge) — see IdentityResolutionService's doc comment for what's deferred.
 *
 * Imports WorkspaceModule for WorkspaceMembershipGuard rather than
 * duplicating the tenant-isolation/authorization boundary.
 */
@Module({
  imports: [WorkspaceModule],
  controllers: [IdentityResolutionController],
  providers: [IdentityResolutionService],
  exports: [IdentityResolutionService],
})
export class IdentityResolutionModule {}
