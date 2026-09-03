import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { IntelligenceEnginesModule } from '../intelligence-engines/intelligence-engines.module';
import { AutomationService } from './automation.service';
import { AutomationController } from './automation.controller';

/**
 * Owns: triggers, conditions, workflow state, scheduling, action execution,
 * approval integration, execution history, retry/failure handling.
 * See: "16. BRAYN Business Action Automation"
 *
 * Phase 1 (doc19 Phase 15): one wired trigger → action pair only — see
 * AutomationService's doc comment for what's deferred (scheduling, AI
 * Action Control integration, retry).
 *
 * Imports IntelligenceEnginesModule to consume RecommendationService
 * (the one available action) and its RevenueOpportunityCreatedPayload
 * type, rather than re-implementing recommendation generation here
 * (doc04 Rule 2). Imports WorkspaceModule for WorkspaceMembershipGuard
 * rather than duplicating the tenant-isolation/authorization boundary.
 */
@Module({
  imports: [WorkspaceModule, IntelligenceEnginesModule],
  controllers: [AutomationController],
  providers: [AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
