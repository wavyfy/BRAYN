import { describe, expect, it, vi } from 'vitest';
import { ReadToolsService, GET_CUSTOMER_ACTIVITY_HISTORY_TOOL } from './read-tools.service';
import { CustomerIntelligenceService, type ActivityEntry } from '../customer-intelligence/customer-intelligence.service';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { RequestContext } from '../../common/logging/request-context';
import { DatabaseService } from '../../database/database.service';
import { UnauthorizedError, ValidationError } from '../../common/errors/app-error';
import type { AiToolCall } from '../ai/ai-provider.interface';

const WORKSPACE_ID = 'ws_1';
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';

const activityFixture: ActivityEntry[] = [
  { type: 'customer_created', occurredAt: new Date('2026-01-01T00:00:00Z'), provider: 'shopify', externalId: 'ext_1' },
];

function makeCustomerIntelligence(overrides: Partial<CustomerIntelligenceService> = {}): CustomerIntelligenceService {
  return {
    getActivity: vi.fn(async () => activityFixture),
    ...overrides,
  } as unknown as CustomerIntelligenceService;
}

function makeDatabase() {
  const values = vi.fn(async () => undefined);
  const insert = vi.fn(() => ({ values }));
  return { database: { client: { insert } } as unknown as DatabaseService, insert, values };
}

function makeLogger(): StructuredLoggerService {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

function makeService(overrides: { customerIntelligence?: CustomerIntelligenceService; database?: DatabaseService; logger?: StructuredLoggerService } = {}) {
  return new ReadToolsService(
    overrides.customerIntelligence ?? makeCustomerIntelligence(),
    overrides.database ?? makeDatabase().database,
    overrides.logger ?? makeLogger(),
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

const activityCall: AiToolCall = { id: 'call_1', name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, arguments: '{}' };

describe('ReadToolsService', () => {
  describe('availableTools', () => {
    it('offers get_customer_activity_history to an owner with a bound customerId', () => {
      const service = makeService();

      const tools = service.availableTools('owner', CUSTOMER_ID);

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe(GET_CUSTOMER_ACTIVITY_HISTORY_TOOL);
      expect(tools[0].parameters).toEqual({ type: 'object', properties: {}, additionalProperties: false });
    });

    it('offers the tool to admin too', () => {
      const service = makeService();

      expect(service.availableTools('admin', CUSTOMER_ID)).toHaveLength(1);
    });

    it('offers no tools for a non-owner/admin role', () => {
      const service = makeService();

      expect(service.availableTools('marketing', CUSTOMER_ID)).toEqual([]);
      expect(service.availableTools('support', CUSTOMER_ID)).toEqual([]);
      expect(service.availableTools('analyst', CUSTOMER_ID)).toEqual([]);
    });

    it('offers no tools when no customerId is bound, regardless of role', () => {
      const service = makeService();

      expect(service.availableTools('owner', undefined)).toEqual([]);
    });

    it('offers no tools for an undefined actor role', () => {
      const service = makeService();

      expect(service.availableTools(undefined, CUSTOMER_ID)).toEqual([]);
    });
  });

  describe('execute', () => {
    it('rejects an unknown tool name', async () => {
      const service = makeService();

      await ownerContext(() =>
        expect(service.execute({ id: 'c', name: 'not_a_real_tool', arguments: '{}' }, WORKSPACE_ID, CUSTOMER_ID)).rejects.toThrow(
          ValidationError,
        ),
      );
    });

    it('calls CustomerIntelligenceService.getActivity with the bound workspaceId/customerId, never anything from call.arguments', async () => {
      const customerIntelligence = makeCustomerIntelligence();
      const service = makeService({ customerIntelligence });
      const call: AiToolCall = { id: 'c', name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL, arguments: '{"workspaceId":"evil","customerId":"evil"}' };

      await ownerContext(() => service.execute(call, WORKSPACE_ID, CUSTOMER_ID));

      expect(customerIntelligence.getActivity).toHaveBeenCalledWith(WORKSPACE_ID, CUSTOMER_ID);
    });

    it('returns the activity as a JSON string', async () => {
      const service = makeService();

      const output = await ownerContext(() => service.execute(activityCall, WORKSPACE_ID, CUSTOMER_ID));

      expect(JSON.parse(output)).toEqual({ activity: activityFixture.map((e) => ({ ...e, occurredAt: e.occurredAt.toISOString() })) });
    });

    it('throws UnauthorizedError for a non-owner/admin actor, defensively, even if somehow called', async () => {
      const service = makeService();

      await expect(marketingContext(() => service.execute(activityCall, WORKSPACE_ID, CUSTOMER_ID))).rejects.toThrow(UnauthorizedError);
    });

    it('records a protected-data-access row scoped to customer_activity', async () => {
      const { database, insert, values } = makeDatabase();
      const service = makeService({ database });

      await ownerContext(() => service.execute(activityCall, WORKSPACE_ID, CUSTOMER_ID));

      expect(insert).toHaveBeenCalled();
      expect(values).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        actorUserId: 'user_1',
        actorRole: 'owner',
        action: 'view',
        resourceType: 'customer_activity',
        resourceId: CUSTOMER_ID,
      });
    });

    it('does not fail the call if the audit write fails, but logs it', async () => {
      const values = vi.fn(async () => {
        throw new Error('db down');
      });
      const database = { client: { insert: vi.fn(() => ({ values })) } } as unknown as DatabaseService;
      const logger = makeLogger();
      const service = makeService({ database, logger });

      const output = await ownerContext(() => service.execute(activityCall, WORKSPACE_ID, CUSTOMER_ID));

      expect(JSON.parse(output)).toHaveProperty('activity');
      expect(logger.event).toHaveBeenCalledWith(
        'error',
        'Failed to record protected-data access',
        'ReadToolsService',
        expect.objectContaining({ errorType: 'Error' }),
      );
    });

    it('never logs activity content', async () => {
      const logger = makeLogger();
      const service = makeService({ logger });

      await ownerContext(() => service.execute(activityCall, WORKSPACE_ID, CUSTOMER_ID));

      expect(logger.event).not.toHaveBeenCalled();
    });
  });
});
