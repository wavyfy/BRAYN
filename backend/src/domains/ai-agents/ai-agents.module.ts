import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { AiModule } from '../ai/ai.module';
import { CustomerIntelligenceModule } from '../customer-intelligence/customer-intelligence.module';
import { IntelligenceEnginesModule } from '../intelligence-engines/intelligence-engines.module';
import { MerchantKnowledgeModule } from '../merchant-knowledge/merchant-knowledge.module';
import { AiActionControlModule } from '../ai-action-control/ai-action-control.module';
import { CommerceModule } from '../commerce/commerce.module';
import { MerchantBusinessAnalystService } from './merchant-business-analyst.service';
import { MerchantBusinessAnalystController } from './merchant-business-analyst.controller';
import { ReadToolsService } from './read-tools.service';
import { WriteToolsService } from './write-tools.service';
import { SalesAgentService } from './sales-agent.service';
import { SupportAgentService } from './support-agent.service';

/**
 * Owns: Merchant Business Analyst, Sales Agent, Support Agent, agent
 * orchestration, tool registry/execution, AI action flow, human
 * escalation. See: "14. BRAYN AI Agents, Tools & Execution" — a
 * distinct domain from "12. BRAYN AI Architecture" (doc04 §03 AI:
 * "AI Architecture" vs "AI Agents, Tools & Execution" are separate
 * owners; doc04 Rule 1 — One Owner).
 *
 * Doc19 Phase 13 — `SalesAgentService`/`SupportAgentService` land here too
 * (doc04 — same owning domain as Merchant Business Analyst, matching how
 * `IntelligenceEnginesModule` hosts multiple sibling capabilities). Both
 * are deliberately unreachable from outside this module for now — no
 * controller, not exported — since their canonical trigger (a real
 * customer message via doc19 Phase 9 item 2 / WAPon) doesn't exist yet;
 * see each service's own doc comment. Reachable only through direct
 * injection in tests until that channel is wired.
 *
 * Imports AiModule for AiGatewayService (never calls a provider
 * directly — doc12 AI Boundary), WorkspaceModule for
 * WorkspaceMembershipGuard rather than duplicating tenant isolation,
 * CustomerIntelligenceModule for the UCIR read (doc19 Phase 12 step 2 —
 * "Customer-aware questions"), and IntelligenceEnginesModule for
 * CustomerHealthService/RevenueOpportunityService (doc19 Phase 12 step 3
 * — "Customer intelligence analysis") — never re-querying those tables
 * or duplicating their calculation logic itself (doc04 Rule 2 —
 * Consume, Don't Duplicate), including RecommendationService's read-only
 * `.list()` (doc19 Phase 12 step 5 — "Recommendations"; `.generate()` is
 * never called from this Q&A path — locked decision, see
 * MerchantBusinessAnalystService's doc comment). MerchantKnowledgeModule
 * provides MerchantKnowledgeService (doc19 Phase 12 step 4 — "Merchant
 * knowledge integration"). `ReadToolsService` (doc19 Phase 12 step 6 —
 * "Controlled read tools") reuses CustomerIntelligenceModule too — no new
 * module import needed. `AiActionControlModule` (Phase 14, already
 * verified) is imported for `WriteToolsService` (doc19 Phase 12 step 7 —
 * "Controlled write tools") — exports `AiActionControlService` and
 * `ACTION_REGISTRY`; this domain never re-implements enforcement, it only
 * calls into it (doc04 Rule 2). `CommerceModule` is imported for
 * `ProductService` (Sales Agent's `search_products` tool — doc19 Phase 13
 * "product discovery"), reusing the Commerce read surface rather than
 * duplicating product data here.
 */
@Module({
  imports: [WorkspaceModule, AiModule, CustomerIntelligenceModule, IntelligenceEnginesModule, MerchantKnowledgeModule, AiActionControlModule, CommerceModule],
  controllers: [MerchantBusinessAnalystController],
  providers: [MerchantBusinessAnalystService, ReadToolsService, WriteToolsService, SalesAgentService, SupportAgentService],
  exports: [MerchantBusinessAnalystService],
})
export class AiAgentsModule {}
