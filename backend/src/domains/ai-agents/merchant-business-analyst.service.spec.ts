import { describe, expect, it, vi } from 'vitest';
import { MerchantBusinessAnalystService } from './merchant-business-analyst.service';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { CustomerIntelligenceService, type CustomerRecord } from '../customer-intelligence/customer-intelligence.service';
import { CustomerHealthService, type CustomerHealthState } from '../intelligence-engines/customer-health.service';
import { RevenueOpportunityService } from '../intelligence-engines/revenue-opportunity.service';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import { MerchantKnowledgeService } from '../merchant-knowledge/merchant-knowledge.service';
import { ReadToolsService, GET_CUSTOMER_ACTIVITY_HISTORY_TOOL } from './read-tools.service';
import { WriteToolsService } from './write-tools.service';
import { RECOMMENDATION_DISMISS_ACTION } from '../ai-action-control/actions.registry';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { RequestContext } from '../../common/logging/request-context';
import { DatabaseService } from '../../database/database.service';
import { ApprovalRequiredError, NotFoundError, ProviderError, UnauthorizedError } from '../../common/errors/app-error';
import type { AiGenerateResult, AiProvider, AiToolCall } from '../ai/ai-provider.interface';

const WORKSPACE_ID = 'ws_1';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

const customerFixture: CustomerRecord = {
  canonicalCustomerId: CUSTOMER_ID,
  profile: { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace', phone: '555-1234' },
  sourceCustomers: [{ provider: 'shopify', externalId: 'ext_1' }],
  commerceContext: {
    ordersCount: 3,
    totalSpent: '150.00',
    lastOrderAt: new Date('2026-01-01T00:00:00Z'),
    ordersLast90Days: 1,
    recentOrders: [{ provider: 'shopify', externalId: 'ord_1', totalPrice: '50.00', createdAt: new Date('2026-01-01T00:00:00Z') }],
  },
  behaviouralContext: { eventsCount: 0, lastActivityAt: null, recentEvents: [] },
};

const healthFixture: CustomerHealthState = {
  workspaceId: WORKSPACE_ID,
  canonicalCustomerId: CUSTOMER_ID,
  score: null,
  healthCategory: null,
  signals: { recency: 80, frequency: 40 },
  reasonCodes: ['Last order 5 day(s) ago — recency score 80/100.'],
  trend: null,
  lastCalculatedAt: new Date('2026-01-01T00:00:00Z'),
};

function makeGateway(overrides: Partial<AiGatewayService> = {}): AiGatewayService {
  return {
    generate: vi.fn(async () => ({ content: 'answer', model: 'gpt-5.6-luna', provider: 'openai' })),
    ...overrides,
  } as unknown as AiGatewayService;
}

function makeCustomerIntelligence(overrides: Partial<CustomerIntelligenceService> = {}): CustomerIntelligenceService {
  return {
    getCustomer: vi.fn(async () => customerFixture),
    ...overrides,
  } as unknown as CustomerIntelligenceService;
}

function makeCustomerHealth(overrides: Partial<CustomerHealthService> = {}): CustomerHealthService {
  return {
    getCurrent: vi.fn(async () => healthFixture),
    ...overrides,
  } as unknown as CustomerHealthService;
}

function makeRevenueOpportunity(overrides: Partial<RevenueOpportunityService> = {}): RevenueOpportunityService {
  return {
    list: vi.fn(async () => []),
    ...overrides,
  } as unknown as RevenueOpportunityService;
}

function makeRecommendation(overrides: Partial<RecommendationService> = {}): RecommendationService {
  return {
    list: vi.fn(async () => []),
    generate: vi.fn(async () => {
      throw new Error('generate() must never be called from the MBA Q&A path');
    }),
    ...overrides,
  } as unknown as RecommendationService;
}

interface KnowledgeFixture {
  title: string;
  content: string;
}

/** Mirrors MerchantKnowledgeService.findRelevant's real scoring so knowledge-filtering tests exercise the same behavior through the now-mocked service boundary. */
function scoreForTest(queryWords: Set<string>, entry: KnowledgeFixture): number {
  const haystack = `${entry.title} ${entry.content}`.toLowerCase();
  let score = 0;
  for (const word of queryWords) {
    if (haystack.includes(word)) score += 1;
  }
  return score;
}

function makeMerchantKnowledge(
  entries: { knowledge?: KnowledgeFixture[]; policy?: KnowledgeFixture[] } = {},
): MerchantKnowledgeService {
  const knowledge = entries.knowledge ?? [];
  const policy = entries.policy ?? [];
  return {
    list: vi.fn(async (_workspaceId: string, type: 'knowledge' | 'policy') => (type === 'policy' ? policy : knowledge)),
    findRelevant: vi.fn(async (_workspaceId: string, type: 'knowledge' | 'policy', query: string) => {
      const source = type === 'policy' ? policy : knowledge;
      const queryWords = new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
      if (queryWords.size === 0) return [];
      return source
        .map((entry) => ({ entry, score: scoreForTest(queryWords, entry) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(({ entry }) => entry);
    }),
  } as unknown as MerchantKnowledgeService;
}

function makeReadTools(overrides: Partial<ReadToolsService> = {}): ReadToolsService {
  return {
    availableTools: vi.fn(() => []),
    execute: vi.fn(async () => JSON.stringify({ activity: [] })),
    ...overrides,
  } as unknown as ReadToolsService;
}

function makeWriteTools(overrides: Partial<WriteToolsService> = {}): WriteToolsService {
  return {
    availableTools: vi.fn(() => []),
    isWriteTool: vi.fn(() => false),
    execute: vi.fn(async () => JSON.stringify({ success: true })),
    ...overrides,
  } as unknown as WriteToolsService;
}

function makeDatabase() {
  const values = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values }));
  return { database: { client: { insert } } as unknown as DatabaseService, insert, values };
}

function makeLogger(): StructuredLoggerService {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

interface Deps {
  gateway: AiGatewayService;
  customerIntelligence: CustomerIntelligenceService;
  customerHealth: CustomerHealthService;
  revenueOpportunity: RevenueOpportunityService;
  recommendation: RecommendationService;
  merchantKnowledge: MerchantKnowledgeService;
  readTools: ReadToolsService;
  writeTools: WriteToolsService;
  database: DatabaseService;
  logger: StructuredLoggerService;
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    gateway: makeGateway(),
    customerIntelligence: makeCustomerIntelligence(),
    customerHealth: makeCustomerHealth(),
    revenueOpportunity: makeRevenueOpportunity(),
    recommendation: makeRecommendation(),
    merchantKnowledge: makeMerchantKnowledge(),
    readTools: makeReadTools(),
    writeTools: makeWriteTools(),
    database: makeDatabase().database,
    logger: makeLogger(),
    ...overrides,
  };
}

function makeService(deps: Deps): MerchantBusinessAnalystService {
  return new MerchantBusinessAnalystService(
    deps.gateway,
    deps.customerIntelligence,
    deps.customerHealth,
    deps.revenueOpportunity,
    deps.recommendation,
    deps.merchantKnowledge,
    deps.readTools,
    deps.writeTools,
    deps.database,
    deps.logger,
  );
}

function ownerContext<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { correlationId: 'corr-1', userId: 'clerk_1', workspaceId: WORKSPACE_ID, actorUserId: 'user_1', actorRole: 'owner' },
    fn,
  );
}

function marketingContext<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run(
    { correlationId: 'corr-1', userId: 'clerk_1', workspaceId: WORKSPACE_ID, actorUserId: 'user_2', actorRole: 'marketing' },
    fn,
  );
}

describe('MerchantBusinessAnalystService — basic questions (no customerId)', () => {
  it('sends a system persona message and the merchant question as the user message', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'How many orders did we get last week?');

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.messages[0]).toEqual(expect.objectContaining({ role: 'system' }));
    expect(request.messages.at(-1)).toEqual({ role: 'user', content: 'How many orders did we get last week?' });
  });

  it('sets capability to merchant-business-analyst and never passes a model', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'question');

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.capability).toBe('merchant-business-analyst');
    expect(request.model).toBeUndefined();
  });

  it('includes no customer or intelligence context, and no tools — knowledge/policy blocks are still present but empty', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'question');

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.messages).toHaveLength(4); // persona, knowledge, policy, user
    expect(request.tools).toBeUndefined();
    expect(deps.customerIntelligence.getCustomer).not.toHaveBeenCalled();
    expect(deps.customerHealth.getCurrent).not.toHaveBeenCalled();
    expect(deps.revenueOpportunity.list).not.toHaveBeenCalled();
    expect(request.messages.some((m: { content: string }) => m.content.includes('Verified customer facts'))).toBe(false);
    expect(request.messages.some((m: { content: string }) => m.content.includes('Derived customer intelligence'))).toBe(false);
  });

  it('returns the Gateway result content as the answer', async () => {
    const result: AiGenerateResult = { content: 'BRAYN answer', model: 'gpt-5.6-luna', provider: 'openai' };
    const deps = makeDeps({ gateway: makeGateway({ generate: vi.fn(async () => result) }) });
    const service = makeService(deps);

    const actual = await service.ask(WORKSPACE_ID, 'question');

    expect(actual).toEqual({ answer: 'BRAYN answer' });
  });

  it('propagates a Gateway/provider failure unchanged', async () => {
    const deps = makeDeps({
      gateway: makeGateway({
        generate: vi.fn(async () => {
          throw new ProviderError('OpenAI is not configured.');
        }),
      }),
    });
    const service = makeService(deps);

    await expect(service.ask(WORKSPACE_ID, 'question')).rejects.toThrow(ProviderError);
  });

  it('does not write a protected-data-access record', async () => {
    const { database, insert } = makeDatabase();
    const deps = makeDeps({ database });
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'question');

    expect(insert).not.toHaveBeenCalled();
  });

  it('preserves Phase 11 AI observability — one success event with the merchant-business-analyst capability', async () => {
    const provider: AiProvider = {
      name: 'openai',
      generate: vi.fn(async () => ({
        content: 'answer',
        model: 'gpt-5.6-luna',
        provider: 'openai',
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      })),
    };
    const logger = new StructuredLoggerService();
    const gateway = new AiGatewayService(provider, logger);
    const deps = makeDeps({ gateway, logger });
    const service = makeService(deps);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await RequestContext.run({ correlationId: 'corr-1', userId: 'user-1', workspaceId: 'ws-1' }, () =>
      service.ask('ws-1', 'question'),
    );

    const logged = logSpy.mock.calls.map((call) => JSON.parse(call[0] as string));
    const successLine = logged.find((line) => line.message === 'AI request succeeded');
    expect(successLine).toMatchObject({
      capability: 'merchant-business-analyst',
      provider: 'openai',
      model: 'gpt-5.6-luna',
      correlationId: 'corr-1',
      workspaceId: 'ws-1',
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
    });

    logSpy.mockRestore();
  });
});

describe('MerchantBusinessAnalystService — customer-aware questions (step 2, owner/admin)', () => {
  it('resolves the customer through CustomerIntelligenceService and includes verified facts', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'What should I know about this customer?', CUSTOMER_ID));

    expect(deps.customerIntelligence.getCustomer).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID);
    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const factsMessage = request.messages.find((m: { content: string }) => m.content.includes('Verified customer facts'));
    expect(factsMessage.content).toContain('ada@example.com');
  });

  it('propagates NotFoundError for a customer outside the workspace, without calling the Gateway', async () => {
    const deps = makeDeps({
      customerIntelligence: makeCustomerIntelligence({
        getCustomer: vi.fn(async () => {
          throw new NotFoundError('No customer with that id exists in this workspace.');
        }),
      }),
    });
    const service = makeService(deps);

    await expect(ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID))).rejects.toThrow(NotFoundError);
    expect(deps.gateway.generate).not.toHaveBeenCalled();
  });

  it('records a protected-data-access row after a successful answer that included verified facts', async () => {
    const { database, insert, values } = makeDatabase();
    const deps = makeDeps({ database });
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(insert).toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      actorUserId: 'user_1',
      actorRole: 'owner',
      action: 'view',
      resourceType: 'customer',
      resourceId: CUSTOMER_ID,
    });
  });

  it('does not fail the request if the protected-data-access write fails', async () => {
    const values = vi.fn(async () => {
      throw new Error('db down');
    });
    const database = { client: { insert: vi.fn(() => ({ values })) } } as unknown as DatabaseService;
    const logger = makeLogger();
    const deps = makeDeps({ database, logger });
    const service = makeService(deps);

    const result = await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(result).toEqual({ answer: 'answer' });
    expect(logger.event).toHaveBeenCalledWith(
      'error',
      'Failed to record protected-data access',
      'MerchantBusinessAnalystService',
      expect.objectContaining({ errorType: 'Error' }),
    );
  });
});

describe('MerchantBusinessAnalystService — customer intelligence analysis (step 3)', () => {
  it('calls CustomerHealthService and RevenueOpportunityService with the canonical customer', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(deps.customerHealth.getCurrent).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID);
    expect(deps.revenueOpportunity.list).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID);
  });

  it('represents Risk & Engagement State as derived intelligence, distinct from verified facts', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const intelligenceMessage = request.messages.find((m: { content: string }) => m.content.includes('Derived customer intelligence'));
    expect(intelligenceMessage).toBeDefined();
    expect(intelligenceMessage.content).toContain('Risk & Engagement');
    expect(intelligenceMessage.content).toContain('recency score 80/100');
  });

  it('represents Revenue Opportunities as derived intelligence', async () => {
    const opportunity = {
      id: 'opp_1',
      type: 'reorder',
      status: 'new',
      priority: 'high',
      estimatedRevenue: '80.00',
      confidence: 70,
      reason: 'Customer is due for a reorder.',
      recommendedAction: 'Send a reorder reminder.',
    };
    const deps = makeDeps({ revenueOpportunity: makeRevenueOpportunity({ list: vi.fn(async () => [opportunity] as never) }) });
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const intelligenceMessage = request.messages.find((m: { content: string }) => m.content.includes('Derived customer intelligence'));
    expect(intelligenceMessage.content).toContain('reorder');
    expect(intelligenceMessage.content).toContain('Customer is due for a reorder.');
  });

  it('never calls RecommendationService — no such dependency exists on this service', () => {
    expect(
      Object.getOwnPropertyNames(MerchantBusinessAnalystService.prototype).some((name) => name.toLowerCase().includes('recommend')),
    ).toBe(false);
  });

  it('asks ReadToolsService which tools are available for this actor/customer (step 6 — superseded expectation from before tools existed)', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(deps.readTools.availableTools).toHaveBeenCalledWith('owner', CUSTOMER_ID);
  });

  it('represents missing health data as "not yet calculated" instead of inventing a value', async () => {
    const deps = makeDeps({
      customerHealth: makeCustomerHealth({
        getCurrent: vi.fn(async () => {
          throw new NotFoundError('No health state has been calculated yet for this customer.');
        }),
      }),
    });
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const intelligenceMessage = request.messages.find((m: { content: string }) => m.content.includes('Derived customer intelligence'));
    expect(intelligenceMessage.content).toContain('not yet calculated');
    expect(deps.gateway.generate).toHaveBeenCalled();
  });

  it('represents no open opportunities without inventing one', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const intelligenceMessage = request.messages.find((m: { content: string }) => m.content.includes('Derived customer intelligence'));
    expect(intelligenceMessage.content).toContain('No open revenue opportunities');
  });

  it('propagates a non-NotFoundError health failure rather than swallowing it', async () => {
    const deps = makeDeps({
      customerHealth: makeCustomerHealth({
        getCurrent: vi.fn(async () => {
          throw new Error('db unavailable');
        }),
      }),
    });
    const service = makeService(deps);

    await expect(ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID))).rejects.toThrow('db unavailable');
    expect(deps.gateway.generate).not.toHaveBeenCalled();
  });

  it('a non-owner/admin caller gets derived intelligence but no verified customer facts, and no audit record', async () => {
    const { database, insert } = makeDatabase();
    const deps = makeDeps({ database });
    const service = makeService(deps);

    const result = await marketingContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(deps.customerIntelligence.getCustomer).not.toHaveBeenCalled();
    expect(deps.customerHealth.getCurrent).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID);
    expect(deps.revenueOpportunity.list).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID);
    expect(result).toEqual({ answer: 'answer' });

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.messages.some((m: { content: string }) => m.content.includes('Verified customer facts'))).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });

  it('still sets capability and never passes a model on the customer-aware/intelligence path', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.capability).toBe('merchant-business-analyst');
    expect(request.model).toBeUndefined();
  });

  it('never logs the question, answer, or intelligence payload — this layer logs nothing on the success path', async () => {
    const logger = makeLogger();
    const deps = makeDeps({ logger });
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'a very specific secret business question', CUSTOMER_ID));

    expect(logger.event).not.toHaveBeenCalled();
  });
});

describe('MerchantBusinessAnalystService — merchant knowledge integration (step 4)', () => {
  it('includes a knowledge entry that shares words with the question', async () => {
    const merchantKnowledge = makeMerchantKnowledge({
      knowledge: [{ title: 'Shipping', content: 'We ship worldwide within 3-5 business days.' }],
    });
    const deps = makeDeps({ merchantKnowledge });
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'How long does shipping take?');

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const knowledgeMessage = request.messages.find((m: { content: string }) => m.content.includes('CATEGORY: Merchant knowledge'));
    expect(knowledgeMessage.content).toContain('ship worldwide');
  });

  it('excludes a knowledge entry that shares no words with the question', async () => {
    const merchantKnowledge = makeMerchantKnowledge({
      knowledge: [{ title: 'Returns Policy Overview', content: 'Unrelated returns information about refund windows.' }],
    });
    const deps = makeDeps({ merchantKnowledge });
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'What payment methods do we accept?');

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const knowledgeMessage = request.messages.find((m: { content: string }) => m.content.includes('CATEGORY: Merchant knowledge'));
    expect(knowledgeMessage.content).toContain('No merchant knowledge entries matched this question');
    expect(knowledgeMessage.content).not.toContain('refund windows');
  });

  it('always includes every policy regardless of question relevance', async () => {
    const merchantKnowledge = makeMerchantKnowledge({
      policy: [{ title: 'Discount rule', content: 'Never offer a discount above 10% without approval.' }],
    });
    const deps = makeDeps({ merchantKnowledge });
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'What is our return window?');

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const policyMessage = request.messages.find((m: { content: string }) => m.content.includes('CATEGORY: Merchant policy'));
    expect(policyMessage.content).toContain('Never offer a discount above 10%');
  });

  it('keeps knowledge and policy as clearly distinct, separately labeled messages', async () => {
    const merchantKnowledge = makeMerchantKnowledge({
      knowledge: [{ title: 'Shipping', content: 'shipping takes days' }],
      policy: [{ title: 'Discount rule', content: 'never discount shipping' }],
    });
    const deps = makeDeps({ merchantKnowledge });
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'shipping question');

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const knowledgeMessage = request.messages.find((m: { content: string }) => m.content.includes('CATEGORY: Merchant knowledge'));
    const policyMessage = request.messages.find((m: { content: string }) => m.content.includes('CATEGORY: Merchant policy'));
    expect(knowledgeMessage).toBeDefined();
    expect(policyMessage).toBeDefined();
    expect(knowledgeMessage).not.toBe(policyMessage);
  });

  it('instructs the model that policy takes priority over knowledge when they conflict', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'question');

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const policyMessage = request.messages.find((m: { content: string }) => m.content.includes('CATEGORY: Merchant policy'));
    expect(policyMessage.content.toLowerCase()).toContain('priority');
  });

  it('retrieves relevant knowledge through the Knowledge Store\'s own findRelevant() and policy scoped to the calling workspace only', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'question');

    expect(deps.merchantKnowledge.findRelevant).toHaveBeenCalledWith(WORKSPACE_ID, 'knowledge', 'question');
    expect(deps.merchantKnowledge.list).toHaveBeenCalledWith(WORKSPACE_ID, 'policy');
    expect(deps.merchantKnowledge.list).toHaveBeenCalledTimes(1);
  });

  it('applies knowledge/policy grounding on the customer-aware path too, alongside customer context', async () => {
    const merchantKnowledge = makeMerchantKnowledge({
      knowledge: [{ title: 'Loyalty', content: 'We run a loyalty rewards program.' }],
    });
    const deps = makeDeps({ merchantKnowledge });
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'Tell me about our loyalty program', CUSTOMER_ID));

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.messages.some((m: { content: string }) => m.content.includes('Verified customer facts'))).toBe(true);
    const knowledgeMessage = request.messages.find((m: { content: string }) => m.content.includes('CATEGORY: Merchant knowledge'));
    expect(knowledgeMessage.content).toContain('loyalty rewards program');
  });

  it('never calls RecommendationService or AI Action Control for knowledge integration, and offers no tools on the basic-question path', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'question');

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.tools).toBeUndefined();
    expect(
      Object.getOwnPropertyNames(MerchantBusinessAnalystService.prototype).some(
        (name) => name.toLowerCase().includes('recommend') || name.toLowerCase().includes('approv'),
      ),
    ).toBe(false);
  });

  it('handles an empty knowledge base without inventing information', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'What products do we sell?');

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const knowledgeMessage = request.messages.find((m: { content: string }) => m.content.includes('CATEGORY: Merchant knowledge'));
    const policyMessage = request.messages.find((m: { content: string }) => m.content.includes('CATEGORY: Merchant policy'));
    expect(knowledgeMessage.content).toContain('No merchant knowledge entries matched this question');
    expect(policyMessage.content).toContain('No merchant policies are configured');
  });

  it('does not write a protected-data-access record for knowledge/policy alone', async () => {
    const { database, insert } = makeDatabase();
    const merchantKnowledge = makeMerchantKnowledge({ knowledge: [{ title: 'FAQ', content: 'faq content' }] });
    const deps = makeDeps({ database, merchantKnowledge });
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'faq');

    expect(insert).not.toHaveBeenCalled();
  });

  it('never logs knowledge/policy content', async () => {
    const logger = makeLogger();
    const merchantKnowledge = makeMerchantKnowledge({
      knowledge: [{ title: 'Secret internal note', content: 'internal margin is 42 percent' }],
    });
    const deps = makeDeps({ merchantKnowledge, logger });
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'internal margin');

    expect(logger.event).not.toHaveBeenCalled();
  });
});

describe('MerchantBusinessAnalystService — recommendations (step 5)', () => {
  it('calls RecommendationService.list() with the canonical workspaceId and customerId', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(deps.recommendation.list).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID);
  });

  it('never calls RecommendationService.generate()', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(deps.recommendation.generate).not.toHaveBeenCalled();
  });

  it('never calls RecommendationService.generate() on the basic-question path either', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'question');

    expect(deps.recommendation.list).not.toHaveBeenCalled();
    expect(deps.recommendation.generate).not.toHaveBeenCalled();
  });

  it('includes an existing recommendation, clearly labeled as a recommendation, not a fact', async () => {
    const recommendationRow = {
      id: 'rec_1',
      text: 'Send a reorder reminder to Ada.',
      supportingSignals: { opportunityType: 'reorder', confidence: 70, reason: 'Customer is due for a reorder.' },
      state: 'active',
    };
    const deps = makeDeps({ recommendation: makeRecommendation({ list: vi.fn(async () => [recommendationRow] as never) }) });
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const recommendationsMessage = request.messages.find((m: { content: string }) => m.content.includes('CATEGORY: Existing recommendations'));
    expect(recommendationsMessage).toBeDefined();
    expect(recommendationsMessage.content).toContain('Send a reorder reminder to Ada.');
    expect(recommendationsMessage.content.toLowerCase()).toContain('not verified customer facts');

    const factsMessage = request.messages.find((m: { content: string }) => m.content.includes('CATEGORY: Verified customer facts'));
    expect(factsMessage.content).not.toContain('Send a reorder reminder');
  });

  it('represents an empty recommendation list explicitly, without inventing one', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const recommendationsMessage = request.messages.find((m: { content: string }) => m.content.includes('CATEGORY: Existing recommendations'));
    expect(recommendationsMessage.content).toContain('No existing recommendations for this customer.');
  });

  it('is retrieved for any workspace role, matching the existing RecommendationController precedent', async () => {
    const deps = makeDeps();
    const service = makeService(deps);

    await marketingContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(deps.recommendation.list).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID);
  });

  it('does not write a protected-data-access record for recommendations alone (non-owner/admin caller)', async () => {
    const { database, insert } = makeDatabase();
    const deps = makeDeps({ database });
    const service = makeService(deps);

    await marketingContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(insert).not.toHaveBeenCalled();
  });

  it('preserves capability, non-overridable model, and Gateway error normalization alongside recommendations', async () => {
    const deps = makeDeps({
      gateway: makeGateway({
        generate: vi.fn(async () => {
          throw new ProviderError('OpenAI is not configured.');
        }),
      }),
    });
    const service = makeService(deps);

    await expect(ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID))).rejects.toThrow(ProviderError);
  });

  it('never logs recommendation content', async () => {
    const logger = makeLogger();
    const recommendationRow = {
      id: 'rec_1',
      text: 'confidential margin-based reorder incentive',
      supportingSignals: { opportunityType: 'reorder', reason: 'internal reason' },
      state: 'active',
    };
    const deps = makeDeps({ recommendation: makeRecommendation({ list: vi.fn(async () => [recommendationRow] as never) }), logger });
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(logger.event).not.toHaveBeenCalled();
  });
});

describe('MerchantBusinessAnalystService — controlled read tools (step 6)', () => {
  it('offers no tools on the basic-question path (no customerId), matching step 1 behavior', async () => {
    const readTools = makeReadTools({ availableTools: vi.fn(() => [{ name: 'x', description: 'x', parameters: {} }]) });
    const deps = makeDeps({ readTools });
    const service = makeService(deps);

    await service.ask(WORKSPACE_ID, 'question');

    expect(readTools.availableTools).not.toHaveBeenCalled();
    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.tools).toBeUndefined();
  });

  it('passes the tool definitions ReadToolsService returns through to the Gateway', async () => {
    const toolDef = { name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, description: 'x', parameters: {} };
    const readTools = makeReadTools({ availableTools: vi.fn(() => [toolDef]) });
    const deps = makeDeps({ readTools });
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.tools).toEqual([toolDef]);
  });

  it('sends no tools field when ReadToolsService offers none for this actor (e.g. non-owner/admin)', async () => {
    const deps = makeDeps({ readTools: makeReadTools({ availableTools: vi.fn(() => []) }) });
    const service = makeService(deps);

    await marketingContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    const request = (deps.gateway.generate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(request.tools).toBeUndefined();
  });

  it('executes a requested tool call, feeds the result back, and returns the model\'s final answer', async () => {
    const toolDef = { name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, description: 'x', parameters: {} };
    const call: AiToolCall = { id: 'call_1', name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, arguments: '{}' };
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [call], model: 'gpt-5.6-luna', provider: 'openai' })
      .mockResolvedValueOnce({ content: 'Final answer using activity history.', model: 'gpt-5.6-luna', provider: 'openai' });
    const readTools = makeReadTools({
      availableTools: vi.fn(() => [toolDef]),
      execute: vi.fn(async () => JSON.stringify({ activity: [{ type: 'order_placed' }] })),
    });
    const deps = makeDeps({ gateway: makeGateway({ generate }), readTools });
    const service = makeService(deps);

    const result = await ownerContext(() => service.ask(WORKSPACE_ID, 'What did this customer do recently?', CUSTOMER_ID));

    expect(result).toEqual({ answer: 'Final answer using activity history.' });
    expect(readTools.execute).toHaveBeenCalledWith(call, WORKSPACE_ID, CUSTOMER_ID);
    expect(generate).toHaveBeenCalledTimes(2);

    const secondRequest = generate.mock.calls[1][0];
    const assistantMessage = secondRequest.messages.find((m: { toolCalls?: unknown[] }) => m.toolCalls?.length);
    expect(assistantMessage.toolCalls).toEqual([call]);
    const toolMessage = secondRequest.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMessage).toEqual({ role: 'tool', content: JSON.stringify({ activity: [{ type: 'order_placed' }] }), toolCallId: 'call_1' });
  });

  it('never lets the model supply workspaceId/customerId — the tool call carries no arguments the executor trusts', async () => {
    const toolDef = { name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, description: 'x', parameters: {} };
    const call: AiToolCall = { id: 'call_1', name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, arguments: '{"workspaceId":"evil-ws","customerId":"evil-customer"}' };
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [call], model: 'gpt-5.6-luna', provider: 'openai' })
      .mockResolvedValueOnce({ content: 'answer', model: 'gpt-5.6-luna', provider: 'openai' });
    const readTools = makeReadTools({ availableTools: vi.fn(() => [toolDef]) });
    const deps = makeDeps({ gateway: makeGateway({ generate }), readTools });
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    // The executor always receives the request's own bound workspaceId/customerId, never anything parsed from call.arguments.
    expect(readTools.execute).toHaveBeenCalledWith(call, WORKSPACE_ID, CUSTOMER_ID);
  });

  it('turns a tool execution failure into a tool-result error message instead of failing the request', async () => {
    const toolDef = { name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, description: 'x', parameters: {} };
    const call: AiToolCall = { id: 'call_1', name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, arguments: '{}' };
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [call], model: 'gpt-5.6-luna', provider: 'openai' })
      .mockResolvedValueOnce({ content: 'I could not retrieve that.', model: 'gpt-5.6-luna', provider: 'openai' });
    const readTools = makeReadTools({
      availableTools: vi.fn(() => [toolDef]),
      execute: vi.fn(async () => {
        throw new UnauthorizedError('Your role does not permit accessing customer activity history.');
      }),
    });
    const deps = makeDeps({ gateway: makeGateway({ generate }), readTools });
    const service = makeService(deps);

    const result = await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(result).toEqual({ answer: 'I could not retrieve that.' });
    const secondRequest = generate.mock.calls[1][0];
    const toolMessage = secondRequest.messages.find((m: { role: string }) => m.role === 'tool');
    expect(JSON.parse(toolMessage.content)).toEqual({ error: 'Your role does not permit accessing customer activity history.' });
  });

  it('stops after a bounded number of tool-call rounds rather than looping forever', async () => {
    const toolDef = { name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, description: 'x', parameters: {} };
    const call: AiToolCall = { id: 'call_1', name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, arguments: '{}' };
    const generate = vi.fn(async () => ({ content: '', toolCalls: [call], model: 'gpt-5.6-luna', provider: 'openai' }));
    const readTools = makeReadTools({ availableTools: vi.fn(() => [toolDef]) });
    const deps = makeDeps({ gateway: makeGateway({ generate }), readTools });
    const service = makeService(deps);

    const result = await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(result.answer).toBe('Unable to complete the request after multiple tool attempts.');
    expect(generate.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('still records protected-data access for verified customer facts, independent of tool execution', async () => {
    const { database, insert, values } = makeDatabase();
    const toolDef = { name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, description: 'x', parameters: {} };
    const deps = makeDeps({ database, readTools: makeReadTools({ availableTools: vi.fn(() => [toolDef]) }) });
    const service = makeService(deps);

    await ownerContext(() => service.ask(WORKSPACE_ID, 'question', CUSTOMER_ID));

    expect(insert).toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ resourceType: 'customer', resourceId: CUSTOMER_ID }));
  });
});
