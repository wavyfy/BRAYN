import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { AiActionControlModule } from '../ai-action-control/ai-action-control.module';
import { AutomationService } from './automation.service';
import { AutomationController } from './automation.controller';

/**
 * Owns: triggers, conditions, workflow state, scheduling, action execution,
 * approval integration, execution history, retry/failure handling.
 * See: "16. BRAYN Business Action Automation"
 *
 * Phase 1 (doc19 Phase 15): one wired trigger → action pair only — see
 * AutomationService's doc comment for what's still deferred (scheduling,
 * retry). AI Action Control integration (doc19 Phase 15 item 7) is done —
 * `runOne()` now calls `AiActionControlService.executeForAutomation()`
 * instead of `RecommendationService.generate()` directly.
 *
 * Imports `AiActionControlModule` for `AiActionControlService` and
 * `ACTION_REGISTRY` (doc04 Rule 2 — consume, don't duplicate; this domain
 * never calls `RecommendationService` directly anymore, only through the
 * registered `ActionDefinition`). `RevenueOpportunityCreatedPayload`
 * stays a type-only import from `intelligence-engines` — no module
 * registration needed for a type. Imports WorkspaceModule for
 * WorkspaceMembershipGuard rather than duplicating the tenant-isolation/
 * authorization boundary.
 */
@Module({
  imports: [WorkspaceModule, AiActionControlModule],
  controllers: [AutomationController],
  providers: [AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
