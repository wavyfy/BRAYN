import { AiGatewayService } from '../ai/ai-gateway.service';
import type { AiMessage, AiToolCall, AiToolDefinition } from '../ai/ai-provider.interface';
import type { CustomerRecord } from '../customer-intelligence/customer-intelligence.service';
import type { RecommendationService } from '../intelligence-engines/recommendation.service';
import type { RevenueOpportunityService } from '../intelligence-engines/revenue-opportunity.service';
import type { MerchantKnowledgeService } from '../merchant-knowledge/merchant-knowledge.service';

/**
 * Doc19 Phase 13 — Sales Agent / Support Agent. Shared with, but
 * deliberately NOT extracted from, `MerchantBusinessAnalystService`
 * (Phase 12, already verified) — touching that file isn't part of this
 * slice and risks regressing shipped/committed behaviour. This file exists
 * so the two NEW agents (Sales, Support) don't duplicate the same
 * context-block/tool-loop shape between each other.
 *
 * Doc14 "Customer-facing agent" — unlike `MerchantBusinessAnalystService`
 * (a workspace member asking about a customer, gated owner/admin per
 * doc28 because it's someone else's PII), the caller these agents are
 * ultimately built for IS the customer themselves once a real channel
 * exists (doc19 Phase 9 item 2 / doc15 — not built yet, see each
 * service's own doc comment). There is no workspace role to gate against
 * for "can this caller see this customer's own data" — so, unlike
 * `ReadToolsService`/`MerchantBusinessAnalystService`, no `actorRole`
 * check gates these blocks. This is a deliberate, documented design
 * choice, not an oversight.
 */

export type RecommendationRow = Awaited<ReturnType<RecommendationService['list']>>[number];
export type RevenueOpportunityRow = Awaited<ReturnType<RevenueOpportunityService['list']>>[number];
export type KnowledgeEntryRow = Awaited<ReturnType<MerchantKnowledgeService['list']>>[number];

const MAX_RELEVANT_KNOWLEDGE_ENTRIES = 5;

/** Same deterministic keyword-overlap scorer as `MerchantBusinessAnalystService` (doc13 — retrieval mechanism is an implementation detail) — duplicated rather than imported since that function isn't exported from a file this domain should otherwise depend on for an unrelated agent's behaviour. */
export function selectRelevantKnowledge(question: string, entries: KnowledgeEntryRow[]): KnowledgeEntryRow[] {
  const questionWords = new Set(question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  if (questionWords.size === 0) {
    return [];
  }

  const scored = entries
    .map((entry) => {
      const haystack = `${entry.title} ${entry.content}`.toLowerCase();
      let score = 0;
      for (const word of questionWords) {
        if (haystack.includes(word)) score += 1;
      }
      return { entry, score };
    })
    .filter(({ score }) => score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RELEVANT_KNOWLEDGE_ENTRIES).map(({ entry }) => entry);
}

/** Doc08 UCIR — stated facts, not conclusions. Same shape as MBA's own block; this is the one context category every customer-facing agent needs (doc14 Customer Context — "Unified Customer Intelligence Record"). */
export function buildCustomerFactsBlock(customer: CustomerRecord): string {
  const { profile, commerceContext } = customer;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'unknown';
  const recentOrders =
    commerceContext.recentOrders
      .map((order) => `${order.provider} order ${order.externalId} (${order.totalPrice ?? 'unknown amount'})`)
      .join('; ') || 'none';

  return [
    'CATEGORY: Verified customer facts (doc08 Unified Customer Intelligence Record). These are stated facts, not ' +
      'conclusions — use them directly, but do not assume anything about this customer beyond what is listed here. ' +
      'Order history here is summary-level only (provider, order id, total) — no fulfillment/tracking status or line ' +
      'items are available; say so rather than inventing shipping detail.',
    '',
    `- Name: ${name}`,
    `- Total orders: ${commerceContext.ordersCount}`,
    `- Total spent: ${commerceContext.totalSpent}`,
    `- Last order at: ${commerceContext.lastOrderAt ? commerceContext.lastOrderAt.toISOString() : 'unknown'}`,
    `- Recent orders: ${recentOrders}`,
  ].join('\n');
}

export function buildMerchantKnowledgeBlock(relevantEntries: KnowledgeEntryRow[]): string {
  const lines =
    relevantEntries.length > 0
      ? relevantEntries.map((entry) => `- ${entry.title}: ${entry.content}`)
      : ['- No merchant knowledge entries matched this question.'];

  return [
    'CATEGORY: Merchant knowledge (doc13 Merchant Knowledge & Policy Store). Business information the merchant has ' +
      'provided — use it to ground your answer, but do not treat it as covering anything beyond what is listed here.',
    '',
    ...lines,
  ].join('\n');
}

/** Doc13 — "Policies have higher authority than general knowledge when they conflict." Not relevance-filtered, same rationale as MBA's own policy block. */
export function buildMerchantPolicyBlock(policies: KnowledgeEntryRow[]): string {
  const lines =
    policies.length > 0
      ? policies.map((entry) => `- ${entry.title}: ${entry.content}`)
      : ['- No merchant policies are configured for this workspace.'];

  return [
    'CATEGORY: Merchant policy (doc13 Merchant Knowledge & Policy Store). These are rules the merchant has set for ' +
      'how you must behave. If a policy conflicts with merchant knowledge or your own judgment, the policy takes ' +
      'priority. You may assess eligibility against a policy, but you cannot execute or confirm any action yourself.',
    '',
    ...lines,
  ].join('\n');
}

/** Doc10 — Revenue Opportunity Detector results (UC-09 — Sales Agent may support "Revenue opportunities"). Not used by Support Agent — UC-10 doesn't list it. */
export function buildRevenueOpportunitiesBlock(opportunities: RevenueOpportunityRow[]): string {
  const lines =
    opportunities.length > 0
      ? opportunities.map(
          (o) => `- ${o.type} (priority: ${o.priority}, confidence: ${o.confidence}): ${o.reason}`,
        )
      : ['- No open revenue opportunities for this customer.'];

  return [
    'CATEGORY: Revenue opportunities (doc10 Customer Intelligence Engines). System-detected opportunities for this ' +
      'customer — present them as suggestions, never as something already offered or agreed to.',
    '',
    ...lines,
  ].join('\n');
}

/** Doc10 — Recommendations (UC-09 — Sales Agent may support product recommendations/cross-sell/upsell/bundles). */
export function buildRecommendationsBlock(recommendations: RecommendationRow[]): string {
  const lines =
    recommendations.length > 0
      ? recommendations.map((r) => `- ${r.text}`)
      : ['- No existing recommendations for this customer.'];

  return [
    'CATEGORY: Existing recommendations (doc10 Customer Intelligence Engines). System-generated suggestions, not ' +
      'verified facts and not something you may claim was already offered — present them as suggestions only.',
    '',
    ...lines,
  ].join('\n');
}

export const ESCALATE_TO_HUMAN_TOOL = 'escalate_to_human';

/**
 * Doc14 Agent Responsibilities — "Escalating when required" — modeled as a
 * tool call rather than free-text parsing of the model's answer: the
 * reasoning belongs to the model (doc14 "Reasoning within their scope"),
 * not a keyword heuristic this code would otherwise have to invent. Has no
 * side effect and touches no write path — it is purely a structured signal
 * this slice's caller can read (`escalate`/`escalationReason` on the
 * result). Persisting/acting on a handoff is doc19 Phase 9 item 3 / UC-12,
 * not built here (no real conversation exists yet to hand off).
 */
export function buildEscalationTool(): AiToolDefinition {
  return {
    name: ESCALATE_TO_HUMAN_TOOL,
    description:
      'Call this when you cannot safely or appropriately continue — the customer explicitly asks for a human, you ' +
      'lack sufficient information/confidence, merchant policy requires human involvement, or the request is ' +
      'outside your scope (e.g. actually processing a refund). Provide a brief reason.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Brief reason a human should take over.' } },
      required: ['reason'],
      additionalProperties: false,
    },
  };
}

const MAX_AGENT_TOOL_ITERATIONS = 3;

export interface AgentResult {
  answer: string;
  escalate: boolean;
  escalationReason?: string;
}

/** A real (non-escalation) tool's executor — takes the raw call, returns its JSON tool-result content. Throwing is caught by the caller and turned into a `{error}` tool result, same shape `MerchantBusinessAnalystService.executeTool` already uses, so a tool failure never ends the turn. */
export type AgentToolExecutor = (call: AiToolCall) => Promise<string>;

/**
 * Doc12 AI Request Lifecycle / doc14 Tool Execution Flow, shared by Sales
 * and Support Agent. `toolExecutors` (keyed by tool name) is how a
 * service-specific tool beyond `escalate_to_human` plugs in — Support
 * Agent still calls this with none (unchanged behaviour: everything
 * besides escalation is still "unknown tool"). An unrecognized tool call
 * (no matching executor) is reported back to the model as a tool-result
 * error rather than crashing the turn, same failure-handling shape
 * `MerchantBusinessAnalystService.executeTool` already uses.
 *
 * Bounded the same way `MerchantBusinessAnalystService.runWithTools` is
 * (doc12 — "Tool execution repeatedly fails" must terminate, not loop
 * forever) — reaching the cap without a final answer is itself treated as
 * an escalation (the one doc14 escalation trigger this code can detect
 * mechanically; the rest are the model's own call via the tool).
 */
export async function runAgentTurn(
  aiGateway: AiGatewayService,
  initialMessages: AiMessage[],
  tools: AiToolDefinition[],
  capability: string,
  toolExecutors: Record<string, AgentToolExecutor> = {},
): Promise<AgentResult> {
  const messages = [...initialMessages];
  let result = await aiGateway.generate({ messages, capability, tools });

  let iterations = 0;
  while (result.toolCalls && result.toolCalls.length > 0 && iterations < MAX_AGENT_TOOL_ITERATIONS) {
    iterations++;
    messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });

    for (const call of result.toolCalls) {
      if (call.name === ESCALATE_TO_HUMAN_TOOL) {
        const reason = parseEscalationReason(call.arguments);
        return { answer: result.content || 'This needs a human to take over.', escalate: true, escalationReason: reason };
      }

      const executor = toolExecutors[call.name];
      const output = executor ? await runToolExecutor(executor, call) : JSON.stringify({ error: `Unknown tool "${call.name}".` });
      messages.push({ role: 'tool', content: output, toolCallId: call.id });
    }

    result = await aiGateway.generate({ messages, capability, tools });
  }

  if (result.toolCalls && result.toolCalls.length > 0) {
    // Hit MAX_AGENT_TOOL_ITERATIONS without a final answer — doc14 "Tool execution repeatedly fails" escalation trigger.
    return { answer: 'Unable to complete this request after multiple attempts.', escalate: true, escalationReason: 'Tool execution repeatedly failed to reach a final answer.' };
  }

  return { answer: result.content || 'Unable to help with this request.', escalate: false };
}

/** Same catch-and-report shape as `MerchantBusinessAnalystService.executeTool` — a thrown error becomes a tool-result the model can react to, never a request-ending throw. */
async function runToolExecutor(executor: AgentToolExecutor, call: AiToolCall): Promise<string> {
  try {
    return await executor(call);
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : 'Tool execution failed.' });
  }
}

function parseEscalationReason(rawArguments: string): string {
  try {
    const parsed = JSON.parse(rawArguments) as { reason?: unknown };
    return typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason : 'The agent requested human handoff.';
  } catch {
    return 'The agent requested human handoff.';
  }
}
