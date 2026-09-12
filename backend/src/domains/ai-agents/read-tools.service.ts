import { Injectable } from '@nestjs/common';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { UnauthorizedError, ValidationError } from '../../common/errors/app-error';
import { RequestContext } from '../../common/logging/request-context';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { DatabaseService } from '../../database/database.service';
import { protectedDataAccessLog } from '../../database/schema/protected-data-access-log';
import type { AiToolDefinition, AiToolCall } from '../ai/ai-provider.interface';

/**
 * Doc19 Phase 12 step 6 — "Controlled read tools" (doc14 Tool
 * Architecture/Read Tools; doc12 AI Request Lifecycle "Response OR Tool
 * Selection"). Scope for this slice: exactly one tool.
 *
 * Every other doc14 Read Tool category (Customer information, Customer
 * Risk & Engagement State, Revenue opportunities, Merchant knowledge,
 * Policies) is already unconditionally provided as static grounding context
 * by MerchantBusinessAnalystService (Phase 12 steps 2-5) — offering those
 * again as callable tools would give the model a second path to data it
 * already has in every call, with no new capability (doc12 Context Builder
 * — "minimal where possible" cuts the other way: don't duplicate). Orders
 * and Products have no existing merchant-facing read method on
 * OrderService/ProductService (both are import-pipeline-only) — adding one
 * would be new service surface, not reuse, so they're deferred rather than
 * built speculatively (see this part's completion report).
 *
 * Customer Activity History is the one doc14 Read Tool category that is
 * NOT already in MBA's static context and DOES have an existing read
 * method to reuse (`CustomerIntelligenceService.getActivity`) — and doc12's
 * own rationale for tool-based (vs. eager) retrieval — "minimal where
 * possible," avoid stuffing not-always-relevant data into every prompt —
 * applies to it specifically: up to 50 chronological events, useful only
 * for some questions.
 *
 * Permission boundary: mirrors `CustomerIntelligenceController`, the one
 * existing consumer of this exact data — owner/admin only, because it
 * returns customer-identifying information tied to a specific customer.
 * Audited the same way (`protectedDataAccessLog`, resourceType
 * `customer_activity` — matching that controller's
 * `@LogsProtectedAccess('customer_activity', ...)`).
 *
 * Tenant/customer scoping never comes from the model: tools carry no
 * `workspaceId`/`customerId` argument at all (empty input schema) — both
 * are bound from the already-authenticated `ask()` call
 * (RequestContext + the caller-supplied `customerId`), not from anything
 * the model's tool-call arguments could contain (doc28 Tenant Isolation —
 * "never... client-provided workspace IDs").
 */
export const GET_CUSTOMER_ACTIVITY_HISTORY_TOOL = 'get_customer_activity_history';

const NO_ARGS_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

@Injectable()
export class ReadToolsService {
  constructor(
    private readonly customerIntelligence: CustomerIntelligenceService,
    private readonly database: DatabaseService,
    private readonly logger: StructuredLoggerService,
  ) {}

  /**
   * Tools this actor may call for a request already bound to `customerId`
   * (doc14 — "Selecting approved tools" is the agent's job, but which
   * tools are even offered is a permission decision made up front here,
   * not left to the model to attempt and get rejected).
   */
  availableTools(actorRole: string | undefined, customerId: string | undefined): AiToolDefinition[] {
    if (!customerId || !this.canAccessActivityHistory(actorRole)) {
      return [];
    }

    return [
      {
        name: GET_CUSTOMER_ACTIVITY_HISTORY_TOOL,
        description:
          "Retrieve this customer's chronological activity history (account creation, orders placed) beyond what's " +
          'already given. Call this only if the question needs specific historical events not already provided.',
        parameters: NO_ARGS_SCHEMA,
      },
    ];
  }

  /**
   * Executes one tool call. Re-checks permission defensively even though
   * `availableTools` already keeps this tool out of the model's options
   * for a disallowed role (doc03 — controls enforced at the boundary that
   * actually executes the action, not only where options are presented).
   * Returns a JSON string — the shape `generate()`'s `tool` message expects
   * as `content` (doc12/doc14 — tool output schema is the tool's own
   * concern, opaque to the Gateway).
   */
  async execute(call: AiToolCall, workspaceId: string, customerId: string): Promise<string> {
    if (call.name !== GET_CUSTOMER_ACTIVITY_HISTORY_TOOL) {
      throw new ValidationError(`Unknown tool "${call.name}".`);
    }

    const actorRole = RequestContext.get()?.actorRole;
    if (!this.canAccessActivityHistory(actorRole)) {
      throw new UnauthorizedError('Your role does not permit accessing customer activity history.');
    }

    const activity = await this.customerIntelligence.getActivity(workspaceId, customerId);
    await this.recordAccess(workspaceId, customerId, actorRole);
    return JSON.stringify({ activity });
  }

  private canAccessActivityHistory(actorRole: string | undefined): boolean {
    return actorRole === 'owner' || actorRole === 'admin';
  }

  /** Mirrors `MerchantBusinessAnalystService.recordProtectedAccess` (same audit shape, different resourceType) — not extracted into a shared helper for this slice, per doc19's "smallest concrete tool set" scope. */
  private async recordAccess(workspaceId: string, resourceId: string, actorRole: string | undefined): Promise<void> {
    const store = RequestContext.get();
    if (!store?.actorUserId || !actorRole) {
      return;
    }

    try {
      await this.database.client.insert(protectedDataAccessLog).values({
        workspaceId,
        actorUserId: store.actorUserId,
        actorRole: actorRole as 'owner' | 'admin' | 'marketing' | 'support' | 'analyst',
        action: 'view',
        resourceType: 'customer_activity',
        resourceId,
      });
    } catch (error) {
      this.logger.event('error', 'Failed to record protected-data access', 'ReadToolsService', {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }
}
