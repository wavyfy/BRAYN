import { Injectable } from '@nestjs/common';
import { AiGatewayService } from '../ai/ai-gateway.service';
import type { AiMessage, AiToolCall, AiToolDefinition } from '../ai/ai-provider.interface';
import { CustomerIntelligenceService, type CustomerRecord } from '../customer-intelligence/customer-intelligence.service';
import { CustomerHealthService, type CustomerHealthState } from '../intelligence-engines/customer-health.service';
import { RevenueOpportunityService } from '../intelligence-engines/revenue-opportunity.service';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import { MerchantKnowledgeService } from '../merchant-knowledge/merchant-knowledge.service';
import { ReadToolsService } from './read-tools.service';
import { NotFoundError } from '../../common/errors/app-error';
import { RequestContext } from '../../common/logging/request-context';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { DatabaseService } from '../../database/database.service';
import { protectedDataAccessLog } from '../../database/schema/protected-data-access-log';

/** Doc14 Tool Execution Flow — bounded so a model that keeps requesting tools can't loop the request forever; doc12 "Tool execution repeatedly fails" is an escalation trigger, and a hard cap is the smallest way to guarantee this request still terminates with an answer. */
const MAX_TOOL_ITERATIONS = 3;

type RevenueOpportunityRow = Awaited<ReturnType<RevenueOpportunityService['list']>>[number];
type KnowledgeEntryRow = Awaited<ReturnType<MerchantKnowledgeService['list']>>[number];
type RecommendationRow = Awaited<ReturnType<RecommendationService['list']>>[number];

/**
 * Doc19 Phase 12 step 4 — "Merchant knowledge integration": doc13 says
 * "retrieve only knowledge relevant to the current task," but the actual
 * schema (`merchant_knowledge_entries`) has no metadata/tags/full-text
 * index to filter on (checked before writing this) — only `type`, which
 * `MerchantKnowledgeService.list` already uses. Doc13 explicitly calls
 * the retrieval mechanism "an implementation detail," so this is a
 * deterministic, bounded keyword-overlap scorer over title+content — the
 * smallest thing that satisfies "relevant," not embeddings/vector search
 * (explicitly out of scope for this slice). Swappable later behind the
 * same signature once real retrieval exists.
 */
const MAX_RELEVANT_KNOWLEDGE_ENTRIES = 5;

function scoreKnowledgeRelevance(questionWords: Set<string>, entry: KnowledgeEntryRow): number {
  const haystack = `${entry.title} ${entry.content}`.toLowerCase();
  let score = 0;
  for (const word of questionWords) {
    if (haystack.includes(word)) {
      score += 1;
    }
  }
  return score;
}

function selectRelevantKnowledge(question: string, entries: KnowledgeEntryRow[]): KnowledgeEntryRow[] {
  const questionWords = new Set((question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));
  if (questionWords.size === 0) {
    return [];
  }

  return entries
    .map((entry) => ({ entry, score: scoreKnowledgeRelevance(questionWords, entry) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RELEVANT_KNOWLEDGE_ENTRIES)
    .map(({ entry }) => entry);
}

/**
 * Knowledge (doc13): "information AI can use to understand the
 * business" — relevance-filtered per `selectRelevantKnowledge` above.
 * Kept in its own CATEGORY, separate from policy, per this slice's
 * explicit requirement (doc13 — knowledge vs. policy are distinct;
 * policy has higher authority when they conflict).
 */
function buildMerchantKnowledgeBlock(relevantEntries: KnowledgeEntryRow[]): string {
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

/**
 * Policy (doc13): "rules that constrain what AI or automation should
 * do... higher authority than general knowledge when they conflict."
 * Unlike knowledge, policies are NOT relevance-filtered — a policy can
 * govern how to answer even when it shares no keywords with the
 * question (e.g. "never discuss competitor pricing"), so every active
 * policy in the workspace is always included (Phase 1 volumes are
 * small; doc13 doesn't scope policy inclusion to task-relevance the way
 * it does for knowledge). This is grounding/instructional context only
 * — no enforcement mechanism exists yet (doc13 Policy Enforcement:
 * "must be enforced through application logic and/or AI Action
 * Control," which is Phase 14, not this slice).
 */
function buildMerchantPolicyBlock(policies: KnowledgeEntryRow[]): string {
  const lines =
    policies.length > 0
      ? policies.map((entry) => `- ${entry.title}: ${entry.content}`)
      : ['- No merchant policies are configured for this workspace.'];

  return [
    'CATEGORY: Merchant policy (doc13 Merchant Knowledge & Policy Store). These are rules the merchant has set for ' +
      'how you must behave. If a policy conflicts with merchant knowledge, your own judgment, or the customer ' +
      'context above, the policy takes priority. This is guidance only — you cannot execute or approve any action.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Doc19 Phase 12 step 5 — "Recommendations" (doc10 §7.3). Read-only:
 * `RecommendationService.list()` only — `.generate()` is never called
 * from this Q&A path (locked decision — a question must not create a
 * database write as a hidden side effect; recommendation generation
 * stays a separate, explicit operation). Its own CATEGORY, distinct
 * from derived intelligence and verified facts (doc10 — "Recommendations
 * must remain distinguishable from confirmed customer facts"; doc27
 * UC-08 — distinguish facts/derived intelligence/recommendations). Empty
 * list is represented explicitly, never invented.
 */
function buildRecommendationsBlock(recommendations: RecommendationRow[]): string {
  const lines =
    recommendations.length > 0
      ? recommendations.map((r) => {
          const signals = r.supportingSignals as { opportunityType?: string; reason?: string };
          const basis = signals.opportunityType ? `${signals.opportunityType} opportunity` : 'a detected opportunity';
          return `- ${r.text} (based on: ${basis}${signals.reason ? ` — ${signals.reason}` : ''})`;
        })
      : ['- No existing recommendations for this customer.'];

  return [
    'CATEGORY: Existing recommendations (doc10 Customer Intelligence Engines). These are system-generated ' +
      'suggestions, not verified customer facts and not something you may claim was executed — present them as ' +
      'suggestions only, and never invent a recommendation that is not listed here.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Doc12 "Prompt & Model Versioning" — minimal representation for this
 * capability's prompts: the version lives in the constant name. No
 * prompt-management/versioning framework exists (Phase 12 scope boundary,
 * doc19) — add one only when a second prompt/version actually needs it.
 *
 * V2: no longer blanket-claims "you do not have access to this merchant's
 * data yet" — that became false the moment step 2 started appending a
 * customer-context system message right after this one, and step 3 adds
 * a second. What's actually invariant across steps 1-3 is the grounding
 * rule, not a claim about what data exists this call — each additional
 * system message (customer facts, derived intelligence) declares its own
 * availability, this one only sets persona + the "don't invent" rule.
 */
const MERCHANT_BUSINESS_ANALYST_SYSTEM_PROMPT_V2 =
  "You are the BRAYN Merchant Business Analyst. Answer the merchant's business question clearly and concisely, " +
  'using only the context explicitly given to you in this conversation. If the question requires information not ' +
  'present in that context, say so rather than inventing an answer.';

const CAPABILITY = 'merchant-business-analyst';

/**
 * Doc19 Phase 12 step 2 — "Customer-aware questions": the named
 * customer's UCIR facts (doc08 — profile + commerce context only, no
 * derived Customer Intelligence Engine output). Doc14 — "Distinguish
 * verified data, derived intelligence... and AI inference" — enforced by
 * instructing the model, not by omitting facts it might misuse; the
 * actual omission is architectural: `CustomerRecord` (from
 * `CustomerIntelligenceService.getCustomer`) never contains Risk &
 * Engagement State, Revenue Opportunities, or recommendations in the
 * first place, so there is nothing derived to accidentally leak in here.
 */
function buildVerifiedCustomerFactsBlock(customer: CustomerRecord): string {
  const { profile, commerceContext } = customer;
  const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || 'unknown';
  const recentOrders =
    commerceContext.recentOrders
      .map((order) => `${order.provider} order ${order.externalId} (${order.totalPrice ?? 'unknown amount'})`)
      .join('; ') || 'none';

  return [
    'CATEGORY: Verified customer facts (doc08 Unified Customer Intelligence Record). These are stated facts, not ' +
      'conclusions — use them directly, but do not assume anything about this customer beyond what is listed here.',
    '',
    `- Name: ${name}`,
    `- Email: ${profile.email ?? 'unknown'}`,
    `- Phone: ${profile.phone ?? 'unknown'}`,
    `- Total orders: ${commerceContext.ordersCount}`,
    `- Total spent: ${commerceContext.totalSpent}`,
    `- Orders in the last 90 days: ${commerceContext.ordersLast90Days}`,
    `- Last order at: ${commerceContext.lastOrderAt ? commerceContext.lastOrderAt.toISOString() : 'unknown'}`,
    `- Recent orders: ${recentOrders}`,
  ].join('\n');
}

/**
 * Doc19 Phase 12 step 3 — "Customer intelligence analysis": Customer
 * Risk & Engagement State + Revenue Opportunity Detector only (doc10) —
 * explicitly NOT Recommendations (doc19 step 5). Labeled a separate
 * CATEGORY from `buildVerifiedCustomerFactsBlock` per this slice's own
 * requirement that the model distinguish derived intelligence from
 * verified fact, matching doc14/doc27 UC-08 ("Distinguish facts, derived
 * intelligence and recommendations... do not invent unavailable
 * information"). `health` is `null` when none has been calculated yet
 * (a normal state, not an error — see MerchantBusinessAnalystService.ask)
 * and is represented as "not yet calculated," never guessed.
 */
function buildDerivedIntelligenceBlock(health: CustomerHealthState | null, opportunities: RevenueOpportunityRow[]): string {
  const healthLines = health
    ? [
        `- Risk & Engagement score: ${health.score ?? 'not yet calculated'}`,
        `- Health category: ${health.healthCategory ?? 'not yet calculated'}`,
        `- Trend: ${health.trend ?? 'not yet calculated'}`,
        `- Reason codes: ${health.reasonCodes.length > 0 ? health.reasonCodes.join('; ') : 'none'}`,
      ]
    : ['- Risk & Engagement State: not yet calculated for this customer.'];

  const opportunityLines =
    opportunities.length > 0
      ? opportunities.map(
          (o) =>
            `- ${o.type} (priority: ${o.priority}, confidence: ${o.confidence}, estimated revenue: ${o.estimatedRevenue ?? 'unknown'}): ${o.reason}`,
        )
      : ['- No open revenue opportunities for this customer.'];

  return [
    'CATEGORY: Derived customer intelligence (doc10 Customer Intelligence Engines). These are system-computed ' +
      'signals, not stated facts and not recommendations — present them as analysis/interpretation, never as raw ' +
      'customer facts, and do not invent values that are marked "not yet calculated".',
    '',
    'Customer Risk & Engagement State:',
    ...healthLines,
    '',
    'Open Revenue Opportunities:',
    ...opportunityLines,
  ].join('\n');
}

/**
 * Doc19 Phase 12 steps 1-5. Every call goes through AiGatewayService,
 * never a provider directly (doc12 AI Boundary) — model is never
 * caller-supplied, so the Gateway always uses the configured default.
 *
 * Permission design (verified against doc28's Phase 1 Permission Matrix,
 * not silently chosen — see completion report):
 * - Verified customer facts (raw PII: email/phone/name) mirror the one
 *   existing precedent for this exact data (`CustomerIntelligenceController`):
 *   owner/admin only. Unchanged from step 2.
 * - Derived intelligence (health, opportunities) mirrors ITS OWN existing
 *   precedent instead: `CustomerHealthController`/`RevenueOpportunityController`
 *   carry no role restriction at all, matching doc28 ("Customer
 *   Intelligence"/"Opportunities": Read+ for every Phase 1 role). So
 *   intelligence is included for ANY workspace member once `customerId`
 *   is supplied — step 2's owner/admin gate is not inherited for it.
 * - `CustomerHealthService.getCurrent` and `RevenueOpportunityService.list`
 *   are independently workspace+customer-scoped (their own SQL WHERE
 *   clauses), so calling them for a non-owner/admin caller never reads
 *   another workspace's data — no new exposure is introduced by skipping
 *   the (owner/admin-gated) UCIR resolution step for those roles.
 */
@Injectable()
export class MerchantBusinessAnalystService {
  constructor(
    private readonly aiGateway: AiGatewayService,
    private readonly customerIntelligence: CustomerIntelligenceService,
    private readonly customerHealth: CustomerHealthService,
    private readonly revenueOpportunity: RevenueOpportunityService,
    private readonly recommendation: RecommendationService,
    private readonly merchantKnowledge: MerchantKnowledgeService,
    private readonly readTools: ReadToolsService,
    private readonly database: DatabaseService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async ask(workspaceId: string, question: string, customerId?: string): Promise<{ answer: string }> {
    const [knowledgeEntries, policyEntries] = await Promise.all([
      this.merchantKnowledge.list(workspaceId, 'knowledge'),
      this.merchantKnowledge.list(workspaceId, 'policy'),
    ]);
    const relevantKnowledge = selectRelevantKnowledge(question, knowledgeEntries);

    if (!customerId) {
      const result = await this.aiGateway.generate({
        messages: [
          { role: 'system', content: MERCHANT_BUSINESS_ANALYST_SYSTEM_PROMPT_V2 },
          { role: 'system', content: buildMerchantKnowledgeBlock(relevantKnowledge) },
          { role: 'system', content: buildMerchantPolicyBlock(policyEntries) },
          { role: 'user', content: question },
        ],
        capability: CAPABILITY,
      });
      return { answer: result.content };
    }

    const actorRole = RequestContext.get()?.actorRole;
    const canAccessCustomerFacts = actorRole === 'owner' || actorRole === 'admin';

    const [customer, health, opportunities, recommendations] = await Promise.all([
      canAccessCustomerFacts ? this.customerIntelligence.getCustomer(workspaceId, customerId) : Promise.resolve(undefined),
      this.getHealthOrNull(workspaceId, customerId),
      this.revenueOpportunity.list(workspaceId, customerId),
      this.recommendation.list(workspaceId, customerId),
    ]);

    const messages: AiMessage[] = [
      { role: 'system', content: MERCHANT_BUSINESS_ANALYST_SYSTEM_PROMPT_V2 },
      ...(customer ? [{ role: 'system' as const, content: buildVerifiedCustomerFactsBlock(customer) }] : []),
      { role: 'system', content: buildDerivedIntelligenceBlock(health, opportunities) },
      { role: 'system', content: buildMerchantKnowledgeBlock(relevantKnowledge) },
      { role: 'system', content: buildMerchantPolicyBlock(policyEntries) },
      { role: 'system', content: buildRecommendationsBlock(recommendations) },
      { role: 'user', content: question },
    ];

    const tools = this.readTools.availableTools(actorRole, customerId);
    const answer = await this.runWithTools(messages, tools, workspaceId, customerId);

    if (customer) {
      await this.recordProtectedAccess(workspaceId, customerId);
    }

    return { answer };
  }

  /**
   * Doc12 AI Request Lifecycle — "Model → Response OR Tool Selection →
   * ... → Tool Execution → Result → Final Response," repeated until the
   * model returns a final answer instead of another tool call (doc14 Tool
   * Execution Flow). When `tools` is empty this makes exactly one
   * `generate()` call with `tools: undefined` — identical to steps 1-5's
   * prior behavior.
   */
  private async runWithTools(
    initialMessages: AiMessage[],
    tools: AiToolDefinition[],
    workspaceId: string,
    customerId: string,
  ): Promise<string> {
    const messages = [...initialMessages];
    const requestTools = tools.length > 0 ? tools : undefined;

    let result = await this.aiGateway.generate({ messages, capability: CAPABILITY, tools: requestTools });

    let iterations = 0;
    while (result.toolCalls && result.toolCalls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });

      for (const call of result.toolCalls) {
        const output = await this.executeTool(call, workspaceId, customerId);
        messages.push({ role: 'tool', content: output, toolCallId: call.id });
      }

      result = await this.aiGateway.generate({ messages, capability: CAPABILITY, tools: requestTools });
    }

    return result.content || 'Unable to complete the request after multiple tool attempts.';
  }

  /**
   * A tool failure becomes a result the model can react to, not a request-
   * ending throw (doc12 AI Failure Handling — "tool failure handling";
   * doc14 "failure behaviour" is a per-tool concern, not "crash the whole
   * answer"). The model sees a JSON error object as the tool's own output
   * and can explain the limitation rather than the caller getting a 5xx
   * for something a merchant's phrasing triggered.
   */
  private async executeTool(call: AiToolCall, workspaceId: string, customerId: string): Promise<string> {
    try {
      return await this.readTools.execute(call, workspaceId, customerId);
    } catch (error) {
      return JSON.stringify({ error: error instanceof Error ? error.message : 'Tool execution failed.' });
    }
  }

  /** No health row yet is a normal state (doc10 — a customer may not have one computed), not a failure. */
  private async getHealthOrNull(workspaceId: string, canonicalCustomerId: string): Promise<CustomerHealthState | null> {
    try {
      return await this.customerHealth.getCurrent(workspaceId, canonicalCustomerId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Manual insert rather than `@LogsProtectedAccess` (doc18/doc28 audit):
   * that decorator reads its resource id from a route *param*
   * (`ProtectedDataAccessInterceptor`), but `customerId` here is an
   * optional *body* field on a single shared route — applying the
   * decorator declaratively would either log every basic question too
   * (wrong: no customer data was touched) or record a null resourceId
   * (imprecise). Fires only when verified customer facts (raw PII) were
   * actually included — derived intelligence alone is not audited here,
   * matching `CustomerHealthController`/`RevenueOpportunityController`,
   * neither of which carries `@LogsProtectedAccess` either (verified,
   * not assumed — see completion report).
   */
  private async recordProtectedAccess(workspaceId: string, resourceId: string): Promise<void> {
    const store = RequestContext.get();
    if (!store?.actorUserId || !store?.actorRole) {
      return;
    }

    try {
      await this.database.client.insert(protectedDataAccessLog).values({
        workspaceId,
        actorUserId: store.actorUserId,
        actorRole: store.actorRole as 'owner' | 'admin' | 'marketing' | 'support' | 'analyst',
        action: 'view',
        resourceType: 'customer',
        resourceId,
      });
    } catch (error) {
      this.logger.event('error', 'Failed to record protected-data access', 'MerchantBusinessAnalystService', {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }
}
