import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { AiModule } from '../ai/ai.module';
import { CustomerIntelligenceModule } from '../customer-intelligence/customer-intelligence.module';
import { IntelligenceEnginesModule } from '../intelligence-engines/intelligence-engines.module';
import { MerchantKnowledgeModule } from '../merchant-knowledge/merchant-knowledge.module';
import { MerchantBusinessAnalystService } from './merchant-business-analyst.service';
import { MerchantBusinessAnalystController } from './merchant-business-analyst.controller';
import { ReadToolsService } from './read-tools.service';

/**
 * Owns: Merchant Business Analyst, Sales Agent, Support Agent, agent
 * orchestration, tool registry/execution, AI action flow, human
 * escalation. See: "14. BRAYN AI Agents, Tools & Execution" — a
 * distinct domain from "12. BRAYN AI Architecture" (doc04 §03 AI:
 * "AI Architecture" vs "AI Agents, Tools & Execution" are separate
 * owners; doc04 Rule 1 — One Owner).
 *
 * Phase 12 step 1 ("Basic merchant questions" — doc19): only the
 * Merchant Business Analyst's narrowest capability exists so far — no
 * customer context, no knowledge grounding, no tools. Sales/Support
 * agents and the tool registry land in later phases per doc19; they'll
 * add their own controller/service to this same module, matching how
 * IntelligenceEnginesModule hosts multiple sibling capabilities.
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
 * module import needed.
 */
@Module({
  imports: [WorkspaceModule, AiModule, CustomerIntelligenceModule, IntelligenceEnginesModule, MerchantKnowledgeModule],
  controllers: [MerchantBusinessAnalystController],
  providers: [MerchantBusinessAnalystService, ReadToolsService],
  exports: [MerchantBusinessAnalystService],
})
export class AiAgentsModule {}
