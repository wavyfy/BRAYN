import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { CustomerIntelligenceService } from './customer-intelligence.service';
import { CustomerIntelligenceController } from './customer-intelligence.controller';

/**
 * Owns the Unified Customer Intelligence Record: customer context, profile,
 * activity history, memory, preferences, commerce/behavioural/conversation
 * context, customer summary.
 * See: "08. BRAYN Unified Customer Intelligence Record"
 *
 * Phase 1: Customer profile + Commerce context, read-only aggregation over
 * Identity Resolution's canonical_customers and Commerce's own tables — see
 * CustomerIntelligenceService's doc comment for what's deferred.
 *
 * Imports WorkspaceModule for WorkspaceMembershipGuard rather than
 * duplicating the tenant-isolation/authorization boundary.
 */
@Module({
  imports: [WorkspaceModule],
  controllers: [CustomerIntelligenceController],
  providers: [CustomerIntelligenceService],
  exports: [CustomerIntelligenceService],
})
export class CustomerIntelligenceModule {}
