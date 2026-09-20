import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { IntelligenceEnginesModule } from '../intelligence-engines/intelligence-engines.module';
import { MerchantKnowledgeModule } from '../merchant-knowledge/merchant-knowledge.module';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import { AiActionControlService } from './ai-action-control.service';
import { AiActionRequestController } from './ai-action-request.controller';
import { ACTION_REGISTRY, buildActionRegistry } from './actions.registry';

export { ACTION_REGISTRY };

/**
 * Doc19 Phase 14 Slice 1 — AI Action Control. Sits architecturally between
 * AI Agents/tool execution and Business Action Automation (doc04's
 * dependency diagram places it as its own layer, distinct from both — see
 * this slice's completion report for the doc04 gap this surfaces). Owns:
 * the action registry, risk/permission/approval decisioning, execution
 * enforcement, and the action-audit trail. Does not own the underlying
 * write operations themselves (those stay in their existing domains —
 * doc04 Rule 2, Consume Don't Duplicate) or any concrete AI agent/tool
 * caller (Phase 12 Step 7 / Phase 13, not this slice).
 *
 * Imports IntelligenceEnginesModule for `RecommendationService` (the two
 * registered actions), MerchantKnowledgeModule for the policy-check
 * boundary, and WorkspaceModule for `WorkspaceMembershipGuard` rather than
 * duplicating tenant isolation/authorization.
 */
@Module({
  imports: [WorkspaceModule, IntelligenceEnginesModule, MerchantKnowledgeModule],
  controllers: [AiActionRequestController],
  providers: [
    {
      provide: ACTION_REGISTRY,
      useFactory: (recommendationService: RecommendationService) => buildActionRegistry(recommendationService),
      inject: [RecommendationService],
    },
    AiActionControlService,
  ],
  exports: [AiActionControlService, ACTION_REGISTRY],
})
export class AiActionControlModule {}
