import { Module } from '@nestjs/common';
import { IdentityResolutionService } from './identity-resolution.service';

/**
 * Owns: identity matching, identity linking, anonymous → known identity,
 * deduplication, customer merging, source identity mapping.
 * See: "09. BRAYN Identity Resolution & Customer Data"
 *
 * Phase 1: deterministic email matching only — see
 * IdentityResolutionService's doc comment for what's deferred.
 */
@Module({
  providers: [IdentityResolutionService],
  exports: [IdentityResolutionService],
})
export class IdentityResolutionModule {}
