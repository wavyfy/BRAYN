import { describe, expect, it, vi } from 'vitest';
import { SalesAgentService } from './sales-agent.service';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { CustomerIntelligenceService, type CustomerRecord } from '../customer-intelligence/customer-intelligence.service';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import { RevenueOpportunityService } from '../intelligence-engines/revenue-opportunity.service';
import { MerchantKnowledgeService } from '../merchant-knowledge/merchant-knowledge.service';
import { ESCALATE_TO_HUMAN_TOOL } from './agent-shared';
import { NotFoundError } from '../../common/errors/app-error';
import type { AiMessage, AiToolCall } from '../ai/ai-provider.interface';

const OTHER_WORKSPACE_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';

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

function makeGateway(overrides: Partial<AiGatewayService> = {}): AiGatewayService {
  return {
    generate: vi.fn(async () => ({ content: 'Here are some product ideas.', model: 'gpt-5.6-luna', provider: 'openai' })),
    ...overrides,
  } as unknown as AiGatewayService;
}

function makeCustomerIntelligence(overrides: Partial<CustomerIntelligenceService> = {}): CustomerIntelligenceService {
  return { getCustomer: vi.fn(async () => customerFixture), ...overrides } as unknown as CustomerIntelligenceService;
}

function makeRecommendation(overrides: Partial<RecommendationService> = {}): RecommendationService {
  return { list: vi.fn(async () => []), ...overrides } as unknown as RecommendationService;
}

function makeRevenueOpportunity(overrides: Partial<RevenueOpportunityService> = {}): RevenueOpportunityService {
  return { list: vi.fn(async () => []), ...overrides } as unknown as RevenueOpportunityService;
}

function makeMerchantKnowledge(entries: { title: string; content: string }[] = []): MerchantKnowledgeService {
  return { list: vi.fn(async () => entries) } as unknown as MerchantKnowledgeService;
}

function makeService(overrides: {
  gateway?: AiGatewayService;
  customerIntelligence?: CustomerIntelligenceService;
  recommendation?: RecommendationService;
  revenueOpportunity?: RevenueOpportunityService;
  merchantKnowledge?: MerchantKnowledgeService;
} = {}) {
  return new SalesAgentService(
    overrides.gateway ?? makeGateway(),
    overrides.customerIntelligence ?? makeCustomerIntelligence(),
    overrides.recommendation ?? makeRecommendation(),
    overrides.revenueOpportunity ?? makeRevenueOpportunity(),
    overrides.merchantKnowledge ?? makeMerchantKnowledge(),
  );
}

function systemMessages(generate: ReturnType<typeof vi.fn>, callIndex = 0): string {
  const request = generate.mock.calls[callIndex][0] as { messages: AiMessage[] };
  return request.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n---\n');
}

/**
 * Doc19 Phase 13 — Sales Agent (doc14, UC-09). Reachable only through
 * direct injection here — no controller exists (see SalesAgentService's
 * own doc comment: deferred until doc19 Phase 9 item 2 / WAPon). Real
 * customer-facing E2E verification is deferred until then; these tests
 * cover the agent's own reasoning/context/escalation behaviour only.
 */
describe('SalesAgentService', () => {
  it('grounds the answer in customer facts, recommendations, opportunities and relevant knowledge', async () => {
    const gateway = makeGateway();
    const customerIntelligence = makeCustomerIntelligence();
    const recommendation = makeRecommendation({ list: vi.fn(async () => [{ id: 'rec_1', text: 'Suggest a reorder.' }] as never) });
    const revenueOpportunity = makeRevenueOpportunity({
      list: vi.fn(async () => [{ type: 'reorder', priority: 'high', confidence: 0.8, reason: 'Due for a reorder.' }] as never),
    });
    const merchantKnowledge = makeMerchantKnowledge([{ title: 'Bundle deal', content: 'Buy two mugs, get a discount.' }]);
    const service = makeService({ gateway, customerIntelligence, recommendation, revenueOpportunity, merchantKnowledge });

    const result = await service.respond(WORKSPACE_ID, CUSTOMER_ID, 'Any bundle deals?');

    expect(result).toEqual({ answer: 'Here are some product ideas.', escalate: false });
    expect(customerIntelligence.getCustomer).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID);
    expect(recommendation.list).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID);
    expect(revenueOpportunity.list).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID);

    const generate = gateway.generate as unknown as ReturnType<typeof vi.fn>;
    const systemContent = systemMessages(generate);
    expect(systemContent).toContain('Ada');
    expect(systemContent).toContain('Suggest a reorder.');
    expect(systemContent).toContain('Due for a reorder.');
    expect(systemContent).toContain('Bundle deal: Buy two mugs, get a discount.');
    expect(generate.mock.calls[0][0].capability).toBe('sales-agent');
  });

  it('excludes knowledge entries that do not match the question', async () => {
    const gateway = makeGateway();
    const merchantKnowledge = makeMerchantKnowledge([{ title: 'Irrelevant entry', content: 'Nothing to do with the question.' }]);
    const service = makeService({ gateway, merchantKnowledge });

    await service.respond(WORKSPACE_ID, CUSTOMER_ID, 'Do you have any winter jackets?');

    const generate = gateway.generate as unknown as ReturnType<typeof vi.fn>;
    expect(systemMessages(generate)).toContain('No merchant knowledge entries matched this question.');
  });

  it('escalates via the escalate_to_human tool without a second gateway call', async () => {
    const call: AiToolCall = { id: 'call_1', name: ESCALATE_TO_HUMAN_TOOL, arguments: JSON.stringify({ reason: 'Customer wants a price match.' }) };
    const gateway = makeGateway({
      generate: vi.fn(async () => ({ content: '', toolCalls: [call], model: 'gpt-5.6-luna', provider: 'openai' })),
    });
    const service = makeService({ gateway });

    const result = await service.respond(WORKSPACE_ID, CUSTOMER_ID, 'Can you match a competitor price?');

    expect(result).toEqual({ answer: 'This needs a human to take over.', escalate: true, escalationReason: 'Customer wants a price match.' });
    expect(gateway.generate).toHaveBeenCalledTimes(1);
  });

  it('reports an unrecognized tool call back to the model and continues the turn', async () => {
    const call: AiToolCall = { id: 'call_1', name: 'not_a_real_tool', arguments: '{}' };
    const generate = vi
      .fn()
      .mockResolvedValueOnce({ content: '', toolCalls: [call], model: 'gpt-5.6-luna', provider: 'openai' })
      .mockResolvedValueOnce({ content: 'Final answer.', model: 'gpt-5.6-luna', provider: 'openai' });
    const service = makeService({ gateway: makeGateway({ generate }) });

    const result = await service.respond(WORKSPACE_ID, CUSTOMER_ID, 'question');

    expect(result).toEqual({ answer: 'Final answer.', escalate: false });
    expect(generate).toHaveBeenCalledTimes(2);
    const secondRequest = generate.mock.calls[1][0] as { messages: AiMessage[] };
    const toolMessage = secondRequest.messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toContain('Unknown tool');
    expect(toolMessage?.content).toContain('not_a_real_tool');
  });

  it('escalates after repeated tool-call iterations never resolve to a final answer', async () => {
    const call: AiToolCall = { id: 'call_1', name: 'not_a_real_tool', arguments: '{}' };
    const generate = vi.fn(async () => ({ content: '', toolCalls: [call], model: 'gpt-5.6-luna', provider: 'openai' }));
    const service = makeService({ gateway: makeGateway({ generate }) });

    const result = await service.respond(WORKSPACE_ID, CUSTOMER_ID, 'question');

    expect(result).toEqual({
      answer: 'Unable to complete this request after multiple attempts.',
      escalate: true,
      escalationReason: 'Tool execution repeatedly failed to reach a final answer.',
    });
  });

  describe('tenant isolation (doc03 rule 3 / doc18 — cross-workspace access must fail closed)', () => {
    it('rejects with NotFoundError when the customer does not belong to the given workspace, without ever calling the model', async () => {
      const gateway = makeGateway();
      const customerIntelligence = makeCustomerIntelligence({
        getCustomer: vi.fn(async () => {
          throw new NotFoundError('No customer with that id exists in this workspace.');
        }),
      });
      const service = makeService({ gateway, customerIntelligence });

      await expect(service.respond(WORKSPACE_ID, OTHER_WORKSPACE_CUSTOMER_ID, 'Any bundle deals?')).rejects.toThrow(NotFoundError);

      expect(gateway.generate).not.toHaveBeenCalled();
    });
  });
});
