import { Injectable } from '@nestjs/common';
import { AiGatewayService } from '../ai/ai-gateway.service';
import type { AiMessage, AiToolCall, AiToolDefinition } from '../ai/ai-provider.interface';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import { RevenueOpportunityService } from '../intelligence-engines/revenue-opportunity.service';
import { MerchantKnowledgeService } from '../merchant-knowledge/merchant-knowledge.service';
import { ProductService } from '../commerce/product.service';
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

export const SEARCH_PRODUCTS_TOOL = 'search_products';
/** Bounded tool output — a product-discovery reply doesn't need the full page size `ProductService.list` defaults to. */
const SEARCH_PRODUCTS_RESULT_LIMIT = 10;

/** Doc14 Sales Agent — "Product discovery," backed by `ProductService.list()` (Commerce read surface). */
function buildProductSearchTool(): AiToolDefinition {
  return {
    name: SEARCH_PRODUCTS_TOOL,
    description:
      "Search the merchant's product catalogue by title. Call this when the customer asks about specific " +
      "products or wants to browse what's available. Returns up to 10 matching products with their variants " +
      '(SKU, price, stock). An empty result means nothing matched this search — tell the customer rather than ' +
      'inventing a product.',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Text to match against product titles. Omit to list products generally.' },
      },
      required: [],
      additionalProperties: false,
    },
  };
}

function parseProductSearchArgs(rawArguments: string): { search?: string } {
  try {
    const parsed = JSON.parse(rawArguments) as { search?: unknown };
    return typeof parsed.search === 'string' && parsed.search.trim() ? { search: parsed.search } : {};
  } catch {
    return {};
  }
}

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
 * **`search_products` tool:** UC-09's "product discovery," now backed by
 * `ProductService.list()` (Commerce read surface added for exactly this
 * gap — see that method's doc comment). Read-only, bounded to
 * `SEARCH_PRODUCTS_RESULT_LIMIT` results; `workspaceId` is always the
 * value this service's own `respond()` was called with, never something
 * the model's tool-call arguments could supply (same tenant-binding rule
 * `ReadToolsService`'s tools follow). `CollectionService` is still
 * untouched — collection browsing isn't part of doc14's Sales Agent scope.
 * "Approved sales actions" still has no registered `ActionDefinition` to
 * call (nothing in `actions.registry.ts` fits a sales action) — building
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
    private readonly product: ProductService,
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

    const tools = [buildEscalationTool(), buildProductSearchTool()];
    return runAgentTurn(this.aiGateway, messages, tools, CAPABILITY, {
      [SEARCH_PRODUCTS_TOOL]: (call) => this.searchProducts(workspaceId, call),
    });
  }

  private async searchProducts(workspaceId: string, call: AiToolCall): Promise<string> {
    const args = parseProductSearchArgs(call.arguments);
    const page = await this.product.list(workspaceId, { search: args.search, limit: SEARCH_PRODUCTS_RESULT_LIMIT });
    return JSON.stringify({ products: page.products, hasMore: page.hasMore });
  }
}
