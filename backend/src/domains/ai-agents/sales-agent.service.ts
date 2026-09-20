import { Injectable } from '@nestjs/common';
import { AiGatewayService } from '../ai/ai-gateway.service';
import type { AiMessage } from '../ai/ai-provider.interface';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import { RevenueOpportunityService } from '../intelligence-engines/revenue-opportunity.service';
import { MerchantKnowledgeService } from '../merchant-knowledge/merchant-knowledge.service';
import {
  type AgentResult,
  buildCustomerFactsBlock,
  buildEscalationTool,
  buildMerchantKnowledgeBlock,
  buildRecommendationsBlock,
  buildRevenueOpportunitiesBlock,
  runAgentTurn,
  selectRelevantKnowledge,
} from './agent-shared';

const CAPABILITY = 'sales-agent';

const SALES_AGENT_SYSTEM_PROMPT =
  'You are the BRAYN Sales Agent, talking directly with a customer. Help with product discovery, recommendations, ' +
  'reorder assistance, cross-sell, upsell, and bundles, using only the context explicitly given to you in this ' +
  'conversation. Present recommendations and opportunities as suggestions, never as confirmed facts. If the ' +
  "customer asks for something outside this scope, or you don't have enough information, call the escalation " +
  'tool rather than guessing.';

/**
 * Doc19 Phase 13 — Sales Agent (doc14, UC-09). Owned by this domain
 * alongside `MerchantBusinessAnalystService` (doc04 §03 AI — "AI Agents,
 * Tools & Execution owns... Sales Agent").
 *
 * **Deferred to when a real channel exists (doc19 Phase 9 item 2 / WAPon,
 * not built yet):** no controller, no route. This service is reachable
 * only through direct injection/unit tests — the canonical trigger (doc15
 * Communication Flow — "Customer → Communication Channel → Conversation →
 * ... → AI") requires an inbound message path that doesn't exist and
 * can't be faked without inventing exactly the kind of unauthenticated
 * "create a message as this customer" endpoint doc15 explicitly withholds
 * for security. Real customer-facing E2E verification is deferred until
 * WAPon lands — see this slice's completion report.
 *
 * **No tools beyond `escalate_to_human`:** UC-09's "product discovery" has
 * no existing read method to call — `ProductService`/`CollectionService`
 * are ingestion-only (verified before writing this; same gap Phase 12 Step
 * 6 already flagged for Orders/Products). Adding one would be new service
 * surface, not reuse — deferred rather than built speculatively.
 * "Approved sales actions" has no registered `ActionDefinition` to call
 * either (nothing in `actions.registry.ts` fits a sales action) — building
 * one now would be inventing a business action the docs don't define.
 *
 * **No role/permission gate on customer data:** unlike
 * `MerchantBusinessAnalystService` (a workspace member asking about
 * someone else's customer — owner/admin gated per doc28), the eventual
 * caller here IS the customer whose own data this is. See `agent-shared.ts`
 * doc comment.
 */
@Injectable()
export class SalesAgentService {
  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly customerIntelligence: CustomerIntelligenceService,
    private readonly recommendation: RecommendationService,
    private readonly revenueOpportunity: RevenueOpportunityService,
    private readonly merchantKnowledge: MerchantKnowledgeService,
  ) {}

  async respond(workspaceId: string, canonicalCustomerId: string, message: string): Promise<AgentResult> {
    const [customer, recommendations, opportunities, knowledgeEntries] = await Promise.all([
      this.customerIntelligence.getCustomer(workspaceId, canonicalCustomerId),
      this.recommendation.list(workspaceId, canonicalCustomerId),
      this.revenueOpportunity.list(workspaceId, canonicalCustomerId),
      this.merchantKnowledge.list(workspaceId, 'knowledge'),
    ]);
    const relevantKnowledge = selectRelevantKnowledge(message, knowledgeEntries);

    const messages: AiMessage[] = [
      { role: 'system', content: SALES_AGENT_SYSTEM_PROMPT },
      { role: 'system', content: buildCustomerFactsBlock(customer) },
      { role: 'system', content: buildRecommendationsBlock(recommendations) },
      { role: 'system', content: buildRevenueOpportunitiesBlock(opportunities) },
      { role: 'system', content: buildMerchantKnowledgeBlock(relevantKnowledge) },
      { role: 'user', content: message },
    ];

    const tools = [buildEscalationTool()];
    return runAgentTurn(this.aiGateway, messages, tools, CAPABILITY);
  }
}
