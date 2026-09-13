import { Injectable } from '@nestjs/common';
import { AiGatewayService } from '../ai/ai-gateway.service';
import type { AiMessage } from '../ai/ai-provider.interface';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { MerchantKnowledgeService } from '../merchant-knowledge/merchant-knowledge.service';
import {
  type AgentResult,
  buildCustomerFactsBlock,
  buildEscalationTool,
  buildMerchantKnowledgeBlock,
  buildMerchantPolicyBlock,
  runAgentTurn,
  selectRelevantKnowledge,
} from './agent-shared';

const CAPABILITY = 'support-agent';

const SUPPORT_AGENT_SYSTEM_PROMPT =
  'You are the BRAYN Support Agent, talking directly with a customer. Help with FAQs, order tracking, ' +
  'product/order information, and assessing return eligibility, using only the context explicitly given to you in ' +
  'this conversation and the merchant policy below. You can assess whether a return/refund looks eligible under ' +
  'merchant policy, but you cannot process or confirm a refund yourself — never claim one was completed. If the ' +
  "customer needs something outside this scope, or you don't have enough information, call the escalation tool " +
  'rather than guessing.';

/**
 * Doc19 Phase 13 — Support Agent (doc14, UC-06, UC-10). Owned by this
 * domain alongside `MerchantBusinessAnalystService` (doc04 §03 AI — "AI
 * Agents, Tools & Execution owns... Support Agent").
 *
 * **Deferred to when a real channel exists** — same reasoning as
 * `SalesAgentService`'s doc comment: no controller, no route, reachable
 * only through direct injection/unit tests until doc19 Phase 9 item 2
 * (WAPon) exists. Real customer-facing E2E verification is deferred until
 * then — see this slice's completion report.
 *
 * **No refund tool:** UC-10/UC-07 "refund request initiation" has no
 * underlying write capability anywhere in the codebase to register as an
 * `ActionDefinition` — `commerce/order.service.ts` only ever *ingests*
 * refunds from a provider, it has no method that creates one. Building
 * that would be new Shopify/WooCommerce write capability, a real
 * integration feature and a high-risk action (doc14's own flagship
 * high-risk example) — well beyond "internal capabilities testable
 * today." The system prompt instructs the agent to assess eligibility
 * against merchant policy only, matching doc14 — "must not independently
 * approve restricted refunds or other high-risk actions."
 *
 * **No order-detail tool, no `get_customer_activity_history` reuse:**
 * order tracking here is limited to the same summary-level
 * `commerceContext.recentOrders` `MerchantBusinessAnalystService` already
 * uses (no fulfillment/tracking status exists anywhere to expose).
 * `ReadToolsService.GET_CUSTOMER_ACTIVITY_HISTORY_TOOL` is deliberately
 * NOT reused — its permission check (`actorRole === 'owner' || 'admin'`)
 * models a *workspace member's* access to someone else's data; the caller
 * here is the customer themselves, a different permission question this
 * slice does not invent an answer for.
 */
@Injectable()
export class SupportAgentService {
  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly customerIntelligence: CustomerIntelligenceService,
    private readonly merchantKnowledge: MerchantKnowledgeService,
  ) {}

  async respond(workspaceId: string, canonicalCustomerId: string, message: string): Promise<AgentResult> {
    const [customer, knowledgeEntries, policyEntries] = await Promise.all([
      this.customerIntelligence.getCustomer(workspaceId, canonicalCustomerId),
      this.merchantKnowledge.list(workspaceId, 'knowledge'),
      this.merchantKnowledge.list(workspaceId, 'policy'),
    ]);
    const relevantKnowledge = selectRelevantKnowledge(message, knowledgeEntries);

    const messages: AiMessage[] = [
      { role: 'system', content: SUPPORT_AGENT_SYSTEM_PROMPT },
      { role: 'system', content: buildCustomerFactsBlock(customer) },
      { role: 'system', content: buildMerchantKnowledgeBlock(relevantKnowledge) },
      { role: 'system', content: buildMerchantPolicyBlock(policyEntries) },
      { role: 'user', content: message },
    ];

    const tools = [buildEscalationTool()];
    return runAgentTurn(this.aiGateway, messages, tools, CAPABILITY);
  }
}
