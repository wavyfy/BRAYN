import { describe, expect, it, vi } from 'vitest';
import { SupportAgentService } from './support-agent.service';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { CustomerIntelligenceService, type CustomerRecord } from '../customer-intelligence/customer-intelligence.service';
import { MerchantKnowledgeService } from '../merchant-knowledge/merchant-knowledge.service';
import { ESCALATE_TO_HUMAN_TOOL } from './agent-shared';
import { NotFoundError } from '../../common/errors/app-error';
import type { AiMessage, AiToolCall } from '../ai/ai-provider.interface';

const WORKSPACE_ID = 'ws_1';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKSPACE_CUSTOMER_ID = '99999999-9999-4999-8999-999999999999';

const customerFixture: CustomerRecord = {
  canonicalCustomerId: CUSTOMER_ID,
  profile: { email: 'ada@example.com', firstName: 'Ada', lastName: 'Lovelace', phone: '555-1234' },
  sourceCustomers: [{ provider: 'shopify', externalId: 'ext_1' }],
  commerceContext: {
    ordersCount: 2,
    totalSpent: '90.00',
    lastOrderAt: new Date('2026-01-05T00:00:00Z'),
    ordersLast90Days: 1,
    recentOrders: [{ provider: 'shopify', externalId: 'ord_9', totalPrice: '45.00', createdAt: new Date('2026-01-05T00:00:00Z') }],
  },
};

function makeGateway(overrides: Partial<AiGatewayService> = {}): AiGatewayService {
  return {
    generate: vi.fn(async () => ({ content: 'Your order shipped yesterday.', model: 'gpt-5.6-luna', provider: 'openai' })),
    ...overrides,
  } as unknown as AiGatewayService;
}

function makeCustomerIntelligence(overrides: Partial<CustomerIntelligenceService> = {}): CustomerIntelligenceService {
  return { getCustomer: vi.fn(async () => customerFixture), ...overrides } as unknown as CustomerIntelligenceService;
}

function makeMerchantKnowledge(entries: { knowledge?: { title: string; content: string }[]; policy?: { title: string; content: string }[] } = {}): MerchantKnowledgeService {
  const knowledge = entries.knowledge ?? [];
  const policy = entries.policy ?? [];
  return {
    list: vi.fn(async (_workspaceId: string, type: 'knowledge' | 'policy') => (type === 'policy' ? policy : knowledge)),
  } as unknown as MerchantKnowledgeService;
}

function makeService(overrides: {
  gateway?: AiGatewayService;
  customerIntelligence?: CustomerIntelligenceService;
  merchantKnowledge?: MerchantKnowledgeService;
} = {}) {
  return new SupportAgentService(
    overrides.gateway ?? makeGateway(),
    overrides.customerIntelligence ?? makeCustomerIntelligence(),
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
 * Doc19 Phase 13 — Support Agent (doc14, UC-06/UC-10). Reachable only
 * through direct injection here — no controller exists (see
 * SupportAgentService's own doc comment: deferred until doc19 Phase 9 item
 * 2 / WAPon). Real customer-facing E2E verification is deferred until
 * then; these tests cover the agent's own reasoning/context/escalation/
 * refund-boundary behaviour only.
 */
describe('SupportAgentService', () => {
  it('grounds the answer in customer facts, merchant knowledge and merchant policy', async () => {
    const gateway = makeGateway();
    const customerIntelligence = makeCustomerIntelligence();
    const merchantKnowledge = makeMerchantKnowledge({
      knowledge: [{ title: 'Shipping', content: 'Orders ship within 2 business days.' }],
      policy: [{ title: 'Returns', content: 'Returns accepted within 30 days of delivery.' }],
    });
    const service = makeService({ gateway, customerIntelligence, merchantKnowledge });

    const result = await service.respond(WORKSPACE_ID, CUSTOMER_ID, 'When will my order ship?');

    expect(result).toEqual({ answer: 'Your order shipped yesterday.', escalate: false });
    expect(customerIntelligence.getCustomer).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID);
    expect(merchantKnowledge.list).toHaveBeenCalledWith(WORKSPACE_ID, 'knowledge');
    expect(merchantKnowledge.list).toHaveBeenCalledWith(WORKSPACE_ID, 'policy');

    const generate = gateway.generate as unknown as ReturnType<typeof vi.fn>;
    const systemContent = systemMessages(generate);
    expect(systemContent).toContain('Ada');
    expect(systemContent).toContain('ord_9');
    expect(systemContent).toContain('Orders ship within 2 business days.');
    expect(systemContent).toContain('Returns accepted within 30 days of delivery.');
    expect(generate.mock.calls[0][0].capability).toBe('support-agent');
  });

  it('instructs the agent it cannot process a refund itself, only assess eligibility', async () => {
    const gateway = makeGateway();
    const service = makeService({ gateway });

    await service.respond(WORKSPACE_ID, CUSTOMER_ID, 'I want a refund.');

    const generate = gateway.generate as unknown as ReturnType<typeof vi.fn>;
    const systemContent = systemMessages(generate);
    expect(systemContent).toContain('you cannot process or confirm a refund yourself');
  });

  it('never claims order tracking detail beyond the summary-level order data available', async () => {
    const gateway = makeGateway();
    const service = makeService({ gateway });

    await service.respond(WORKSPACE_ID, CUSTOMER_ID, 'Where is my package right now?');

    const generate = gateway.generate as unknown as ReturnType<typeof vi.fn>;
    expect(systemMessages(generate)).toContain('no fulfillment/tracking status or line items are available');
  });

  it('escalates via the escalate_to_human tool without a second gateway call', async () => {
    const call: AiToolCall = { id: 'call_1', name: ESCALATE_TO_HUMAN_TOOL, arguments: JSON.stringify({ reason: 'Customer is upset and wants a manager.' }) };
    const gateway = makeGateway({
      generate: vi.fn(async () => ({ content: '', toolCalls: [call], model: 'gpt-5.6-luna', provider: 'openai' })),
    });
    const service = makeService({ gateway });

    const result = await service.respond(WORKSPACE_ID, CUSTOMER_ID, 'I demand a manager.');

    expect(result).toEqual({ answer: 'This needs a human to take over.', escalate: true, escalationReason: 'Customer is upset and wants a manager.' });
    expect(gateway.generate).toHaveBeenCalledTimes(1);
  });

  it('falls back to a generic escalation reason when the tool call omits one', async () => {
    const call: AiToolCall = { id: 'call_1', name: ESCALATE_TO_HUMAN_TOOL, arguments: '{}' };
    const gateway = makeGateway({
      generate: vi.fn(async () => ({ content: '', toolCalls: [call], model: 'gpt-5.6-luna', provider: 'openai' })),
    });
    const service = makeService({ gateway });

    const result = await service.respond(WORKSPACE_ID, CUSTOMER_ID, 'help');

    expect(result.escalate).toBe(true);
    expect(result.escalationReason).toBe('The agent requested human handoff.');
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

      await expect(service.respond(WORKSPACE_ID, OTHER_WORKSPACE_CUSTOMER_ID, 'Where is my order?')).rejects.toThrow(NotFoundError);

      expect(gateway.generate).not.toHaveBeenCalled();
    });
  });
});
