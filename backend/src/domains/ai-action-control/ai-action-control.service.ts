import { Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { ApprovalRequiredError, UnauthorizedError, ValidationError } from '../../common/errors/app-error';
import { RequestContext } from '../../common/logging/request-context';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { DatabaseService } from '../../database/database.service';
import { aiActionRequests } from '../../database/schema/ai-action-requests';
import { MerchantKnowledgeService } from '../merchant-knowledge/merchant-knowledge.service';
import type { WorkspaceRole } from '../workspace/dto/add-member.schema';
import type { ActionDefinition, ActionExecutionContext } from './action-definition';

type ApprovalState = 'not_required' | 'pending' | 'approved' | 'denied';
type ExecutionStatus = 'blocked_validation' | 'blocked_permission' | 'blocked_approval' | 'executed' | 'failed';

interface AuditFields {
  action: string;
  riskLevel: 'low' | 'medium' | 'high';
  permissionDecision: 'permitted' | 'denied' | null;
  approvalState: ApprovalState;
  executionStatus: ExecutionStatus;
  inputSummary: unknown;
  resultSummary?: unknown;
  failureReason?: string;
}

/**
 * Doc19 Phase 14 Slice 1 — AI Action Control. The single enforcement point
 * between an AI/tool action request and the actual write (doc03 rule 7):
 *
 *   Input Validation -> Permission/Policy Check -> AI Action Control
 *   (risk/approval) -> Execution -> Audit
 *
 * A registered `ActionDefinition`'s `execute` must never be called by
 * anything other than this service — callers (a future Phase 12 Step 7 /
 * Phase 13 tool executor) only ever hold the definition + this service,
 * never a direct reference to the underlying write method.
 *
 * `workspaceId`/`customerId` come from `context`, which the CALLER is
 * responsible for sourcing from `RequestContext`/route params — never
 * from the action's own (model-suppliable) input (doc03 rule 3, doc28
 * Tenant Isolation). Actor identity (`actorUserId`/`actorRole`) and
 * `correlationId` are read from `RequestContext` directly, the same way
 * `ReadToolsService` (Phase 12 Step 6) already does.
 */
@Injectable()
export class AiActionControlService {
  constructor(
    private readonly database: DatabaseService,
    private readonly merchantKnowledge: MerchantKnowledgeService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async execute<TInput, TResult>(
    definition: ActionDefinition<TInput, TResult>,
    rawInput: unknown,
    context: ActionExecutionContext,
  ): Promise<TResult> {
    const parsed = definition.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      await this.audit(context, {
        action: definition.name,
        riskLevel: definition.riskLevel,
        permissionDecision: null,
        approvalState: 'not_required',
        executionStatus: 'blocked_validation',
        inputSummary: null,
        failureReason: 'Invalid input.',
      });
      throw new ValidationError(`Invalid input for action "${definition.name}".`);
    }

    const actorRole = RequestContext.get()?.actorRole as WorkspaceRole | undefined;
    if (!actorRole || !definition.allowedRoles.includes(actorRole)) {
      await this.audit(context, {
        action: definition.name,
        riskLevel: definition.riskLevel,
        permissionDecision: 'denied',
        approvalState: 'not_required',
        executionStatus: 'blocked_permission',
        inputSummary: parsed.data,
      });
      throw new UnauthorizedError(`Your role does not permit the action "${definition.name}".`);
    }

    // Policy-check boundary (doc13/doc14 — merchant policy must be checked before an action executes).
    // Reuses the existing Merchant Knowledge & Policy Store read path; free-text policies have no
    // canonical matching rule against a specific action yet (see this slice's completion report) —
    // this deliberately stops at "the boundary exists and is consulted," not a rule engine.
    await this.merchantKnowledge.list(context.workspaceId, 'policy');

    if (definition.requiresApproval) {
      await this.audit(context, {
        action: definition.name,
        riskLevel: definition.riskLevel,
        permissionDecision: 'permitted',
        approvalState: 'pending',
        executionStatus: 'blocked_approval',
        inputSummary: parsed.data,
      });
      throw new ApprovalRequiredError(`Action "${definition.name}" requires merchant approval before it can execute.`);
    }

    try {
      const result = await definition.execute(parsed.data, context);
      await this.audit(context, {
        action: definition.name,
        riskLevel: definition.riskLevel,
        permissionDecision: 'permitted',
        approvalState: 'not_required',
        executionStatus: 'executed',
        inputSummary: parsed.data,
        resultSummary: definition.summarizeResult ? definition.summarizeResult(result) : null,
      });
      return result;
    } catch (error) {
      await this.audit(context, {
        action: definition.name,
        riskLevel: definition.riskLevel,
        permissionDecision: 'permitted',
        approvalState: 'not_required',
        executionStatus: 'failed',
        inputSummary: parsed.data,
        failureReason: error instanceof Error ? error.message : 'Action execution failed.',
      });
      throw error;
    }
  }

  /** Doc19 Phase 14 Visible Result — "Merchant can clearly see when an AI action: Can execute automatically / Requires approval / Is blocked." Newest first, capped at 50 (same order/limit convention as `RevenueOpportunityService.list`/`RecommendationService.list`). */
  async listRecent(workspaceId: string) {
    return this.database.client
      .select()
      .from(aiActionRequests)
      .where(eq(aiActionRequests.workspaceId, workspaceId))
      .orderBy(desc(aiActionRequests.createdAt))
      .limit(50);
  }

  private async audit(context: ActionExecutionContext, fields: AuditFields): Promise<void> {
    const store = RequestContext.get();
    if (!store?.actorUserId || !store?.actorRole) {
      return;
    }

    try {
      await this.database.client.insert(aiActionRequests).values({
        workspaceId: context.workspaceId,
        actorUserId: store.actorUserId,
        actorRole: store.actorRole as 'owner' | 'admin' | 'marketing' | 'support' | 'analyst',
        action: fields.action,
        riskLevel: fields.riskLevel,
        permissionDecision: fields.permissionDecision,
        approvalState: fields.approvalState,
        executionStatus: fields.executionStatus,
        inputSummary: fields.inputSummary,
        resultSummary: fields.resultSummary ?? null,
        failureReason: fields.failureReason ?? null,
        correlationId: store.correlationId,
      });
    } catch (error) {
      this.logger.event('error', 'Failed to record AI action audit', 'AiActionControlService', {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }
}
