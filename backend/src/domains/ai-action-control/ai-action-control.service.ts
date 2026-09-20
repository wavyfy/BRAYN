import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ApprovalRequiredError, ConflictError, NotFoundError, UnauthorizedError, ValidationError } from '../../common/errors/app-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { RequestContext } from '../../common/logging/request-context';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { DatabaseService } from '../../database/database.service';
import { aiActionRequests } from '../../database/schema/ai-action-requests';
import { MerchantKnowledgeService } from '../merchant-knowledge/merchant-knowledge.service';
import type { WorkspaceRole } from '../workspace/dto/add-member.schema';
import type { ActionDefinition, ActionExecutionContext } from './action-definition';
import { ACTION_REGISTRY, findActionByName, type ActionRegistry } from './actions.registry';

type ApprovalState = 'not_required' | 'pending' | 'approved' | 'denied';
type ExecutionStatus =
  | 'blocked_validation'
  | 'blocked_permission'
  | 'blocked_approval'
  | 'duplicate'
  | 'executed'
  | 'failed';

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

type ExecutionOutcome<TResult> =
  | { executionStatus: 'executed'; result: TResult; resultSummary: Record<string, unknown> | null }
  | { executionStatus: 'duplicate'; failureReason: string }
  | { executionStatus: 'failed'; failureReason: string; error: unknown };

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
 *
 * Doc19 Phase 14 Slice 2 — idempotency. `idempotencyKey` is an opaque
 * token the CALLER generates and reuses across retries of the SAME
 * logical execution (never derived from workspaceId/action/input — doc03
 * rule 5's "duplicate delivery" is about the caller's own retry, not a
 * hash of the request shape — and never AI/model-supplied, same trust
 * boundary as `context`). Reuses `IdempotencyService` unmodified — same
 * `reserve()`/`complete()` contract `WebhookIngestService` already uses,
 * namespaced here as `ai-action:<workspaceId>:<action>:<key>` so two
 * workspaces (or two different actions) can never collide on the same
 * caller-chosen string (doc03 rule 3 — tenant isolation must not depend
 * solely on the caller getting this right).
 *
 * Placement: AFTER permission/policy/approval, immediately before
 * `execute` — those earlier gates are deterministic per role/input/risk
 * and don't need retry-safety; only the actual write does. This also
 * matches `WebhookIngestService`'s own placement (reserve only once a
 * delivery is already known-valid) and its own limitation: `reserve()`
 * has no release/rollback, so a request that reserves a key and then
 * fails execution leaves that key permanently unable to retry through
 * this path — identical to the webhook precedent, not a new gap.
 */
@Injectable()
export class AiActionControlService {
  constructor(
    private readonly database: DatabaseService,
    private readonly merchantKnowledge: MerchantKnowledgeService,
    private readonly idempotency: IdempotencyService,
    private readonly logger: StructuredLoggerService,
    @Inject(ACTION_REGISTRY) private readonly registry: ActionRegistry,
  ) {}

  async execute<TInput, TResult>(
    definition: ActionDefinition<TInput, TResult>,
    rawInput: unknown,
    context: ActionExecutionContext,
    idempotencyKey: string,
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

    const namespacedKey = `ai-action:${context.workspaceId}:${definition.name}:${idempotencyKey}`;
    const outcome = await this.runExecution(definition, parsed.data, context, namespacedKey);

    if (outcome.executionStatus === 'duplicate') {
      await this.audit(context, {
        action: definition.name,
        riskLevel: definition.riskLevel,
        permissionDecision: 'permitted',
        approvalState: 'not_required',
        executionStatus: 'duplicate',
        inputSummary: parsed.data,
        failureReason: outcome.failureReason,
      });
      throw new ConflictError(`Action "${definition.name}" was already requested with this idempotency key.`);
    }

    if (outcome.executionStatus === 'failed') {
      await this.audit(context, {
        action: definition.name,
        riskLevel: definition.riskLevel,
        permissionDecision: 'permitted',
        approvalState: 'not_required',
        executionStatus: 'failed',
        inputSummary: parsed.data,
        failureReason: outcome.failureReason,
      });
      throw outcome.error;
    }

    await this.audit(context, {
      action: definition.name,
      riskLevel: definition.riskLevel,
      permissionDecision: 'permitted',
      approvalState: 'not_required',
      executionStatus: 'executed',
      inputSummary: parsed.data,
      resultSummary: outcome.resultSummary,
    });
    return outcome.result;
  }

  /**
   * Doc19 Phase 15 item 7 — AI Action Control integration for Business
   * Action Automation (doc16 Core Flow: "Automation → Conditions → AI
   * Action Control/Approval → Action Executor"). Automation is
   * system-triggered (an `@OnEvent` handler, not an authenticated HTTP
   * request) — there is no human actor to check a role against, so unlike
   * `execute()` this skips the `allowedRoles` permission check entirely.
   * The automation's own `enabled` flag and workspace scope (already
   * enforced by `AutomationService` before this is ever called) is the
   * authorization boundary here, not a role. Every other gate still
   * applies unchanged: input validation, the policy-check boundary, the
   * `requiresApproval` gate (future-proofs a later medium/high-risk
   * automation action — doc16 draws automation through approval too),
   * idempotency, execution, and audit.
   *
   * Does not use `RequestContext` at all (an event handler has no
   * guaranteed request context to read) — `correlationId` is supplied by
   * the caller instead (e.g. the triggering `DomainEvent`'s own `id`,
   * doc18 Correlation & Traceability), and the resulting audit row is
   * written with `actorUserId`/`actorRole` both null (doc19 Phase 15
   * item 7 — "system-initiated automation requests have nullable
   * actorUserId/actorRole").
   */
  async executeForAutomation<TInput, TResult>(
    definition: ActionDefinition<TInput, TResult>,
    rawInput: unknown,
    context: ActionExecutionContext,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<TResult> {
    const parsed = definition.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      await this.auditSystem(context, correlationId, {
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

    // Policy-check boundary — same as execute() (doc13/doc14).
    await this.merchantKnowledge.list(context.workspaceId, 'policy');

    if (definition.requiresApproval) {
      await this.auditSystem(context, correlationId, {
        action: definition.name,
        riskLevel: definition.riskLevel,
        permissionDecision: null,
        approvalState: 'pending',
        executionStatus: 'blocked_approval',
        inputSummary: parsed.data,
      });
      throw new ApprovalRequiredError(`Action "${definition.name}" requires merchant approval before it can execute.`);
    }

    const namespacedKey = `ai-action-automation:${context.workspaceId}:${definition.name}:${idempotencyKey}`;
    const outcome = await this.runExecution(definition, parsed.data, context, namespacedKey);

    if (outcome.executionStatus === 'duplicate') {
      await this.auditSystem(context, correlationId, {
        action: definition.name,
        riskLevel: definition.riskLevel,
        permissionDecision: null,
        approvalState: 'not_required',
        executionStatus: 'duplicate',
        inputSummary: parsed.data,
        failureReason: outcome.failureReason,
      });
      throw new ConflictError(`Action "${definition.name}" was already requested with this idempotency key.`);
    }

    if (outcome.executionStatus === 'failed') {
      await this.auditSystem(context, correlationId, {
        action: definition.name,
        riskLevel: definition.riskLevel,
        permissionDecision: null,
        approvalState: 'not_required',
        executionStatus: 'failed',
        inputSummary: parsed.data,
        failureReason: outcome.failureReason,
      });
      throw outcome.error;
    }

    await this.auditSystem(context, correlationId, {
      action: definition.name,
      riskLevel: definition.riskLevel,
      permissionDecision: null,
      approvalState: 'not_required',
      executionStatus: 'executed',
      inputSummary: parsed.data,
      resultSummary: outcome.resultSummary,
    });
    return outcome.result;
  }

  /**
   * Doc19 Phase 14 Approval-Grant Workflow. Does NOT re-enter `execute()` —
   * that would re-check `requiresApproval` (immediate re-throw) and the
   * *requester's* `allowedRoles` (wrong permission: doc28 draws "AI action
   * approval" as its own row, separate from "AI action execution", and the
   * approver may be a different person with different role standing).
   * Authorization for who may call this at all is the controller's own
   * `owner`/`admin` guard, matching doc28's approval row exactly.
   *
   * The `pending`-guarded `UPDATE ... WHERE approvalState = 'pending'` is
   * the actual concurrency lock — only one of two racing approve() calls
   * for the same row can ever get a non-empty `RETURNING`. The
   * `ai-action-approval:${requestId}` idempotency reservation underneath
   * is defense-in-depth on top of that (per this slice's approved design),
   * not the primary guard, so it should rarely if ever observe 'duplicate'
   * in practice.
   */
  async approve(requestId: string, context: Pick<ActionExecutionContext, 'workspaceId'>): Promise<void> {
    const request = await this.findRequestOrThrow(requestId, context.workspaceId);
    if (request.approvalState !== 'pending') {
      throw new ConflictError(`Action request "${requestId}" is not pending approval.`);
    }

    const definition = findActionByName(this.registry, request.action);
    if (!definition) {
      throw new NotFoundError(`Action "${request.action}" is no longer registered.`);
    }

    const parsed = definition.inputSchema.safeParse(request.inputSummary);
    if (!parsed.success) {
      throw new ValidationError(`Stored input for action "${request.action}" is no longer valid.`);
    }

    const decidedByUserId = this.requireActor();

    const claimed = await this.database.client
      .update(aiActionRequests)
      .set({ approvalState: 'approved', decidedByUserId, decidedAt: new Date() })
      .where(
        and(
          eq(aiActionRequests.id, requestId),
          eq(aiActionRequests.workspaceId, context.workspaceId),
          eq(aiActionRequests.approvalState, 'pending'),
        ),
      )
      .returning({ id: aiActionRequests.id });

    if (claimed.length === 0) {
      throw new ConflictError(`Action request "${requestId}" is not pending approval.`);
    }

    const executionContext: ActionExecutionContext = { workspaceId: context.workspaceId, customerId: request.customerId ?? undefined };
    const namespacedKey = `ai-action-approval:${requestId}`;
    const outcome = await this.runExecution(definition, parsed.data, executionContext, namespacedKey);

    if (outcome.executionStatus === 'duplicate') {
      throw new ConflictError(`Action request "${requestId}" was already approved.`);
    }

    await this.database.client
      .update(aiActionRequests)
      .set({
        executionStatus: outcome.executionStatus,
        resultSummary: outcome.executionStatus === 'executed' ? outcome.resultSummary : null,
        failureReason: outcome.executionStatus === 'failed' ? outcome.failureReason : null,
      })
      .where(eq(aiActionRequests.id, requestId));

    if (outcome.executionStatus === 'failed') {
      throw outcome.error;
    }
  }

  /** Doc19 Phase 14 Approval-Grant Workflow — the mirror of `approve()` with no execution step. Same `pending`-guarded atomic transition as the concurrency lock. */
  async deny(requestId: string, context: Pick<ActionExecutionContext, 'workspaceId'>): Promise<void> {
    const request = await this.findRequestOrThrow(requestId, context.workspaceId);
    if (request.approvalState !== 'pending') {
      throw new ConflictError(`Action request "${requestId}" is not pending approval.`);
    }

    const decidedByUserId = this.requireActor();

    const claimed = await this.database.client
      .update(aiActionRequests)
      .set({ approvalState: 'denied', decidedByUserId, decidedAt: new Date() })
      .where(
        and(
          eq(aiActionRequests.id, requestId),
          eq(aiActionRequests.workspaceId, context.workspaceId),
          eq(aiActionRequests.approvalState, 'pending'),
        ),
      )
      .returning({ id: aiActionRequests.id });

    if (claimed.length === 0) {
      throw new ConflictError(`Action request "${requestId}" is not pending approval.`);
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

  private async findRequestOrThrow(requestId: string, workspaceId: string) {
    const [request] = await this.database.client
      .select()
      .from(aiActionRequests)
      .where(and(eq(aiActionRequests.id, requestId), eq(aiActionRequests.workspaceId, workspaceId)))
      .limit(1);

    if (!request) {
      throw new NotFoundError(`No AI action request "${requestId}" exists in this workspace.`);
    }
    return request;
  }

  /** Approver identity must come from trusted server context, never the request body (doc03 rule 3). */
  private requireActor(): string {
    const actorUserId = RequestContext.get()?.actorUserId;
    if (!actorUserId) {
      throw new UnauthorizedError('An authenticated actor is required to decide on an action request.');
    }
    return actorUserId;
  }

  /** Reserve → execute → complete, shared by `execute()` (new request) and `approve()` (resuming a decided one). Reports the outcome; callers own how/whether to persist it. */
  private async runExecution<TInput, TResult>(
    definition: ActionDefinition<TInput, TResult>,
    input: TInput,
    context: ActionExecutionContext,
    namespacedKey: string,
  ): Promise<ExecutionOutcome<TResult>> {
    const reserved = await this.idempotency.reserve(namespacedKey);
    if (!reserved) {
      return { executionStatus: 'duplicate', failureReason: 'This action was already requested with the same idempotency key.' };
    }

    try {
      const result = await definition.execute(input, context);
      // No `complete()` call here on failure, deliberately — same as `WebhookIngestService`'s own
      // failure path: the key stays reserved-but-incomplete rather than being silently released, so
      // a blind retry can't paper over a real execution failure. Recovery from this state is a
      // separate, explicit operation, not built here.
      await this.idempotency.complete(namespacedKey);
      return { executionStatus: 'executed', result, resultSummary: definition.summarizeResult ? definition.summarizeResult(result) : null };
    } catch (error) {
      return { executionStatus: 'failed', failureReason: error instanceof Error ? error.message : 'Action execution failed.', error };
    }
  }

  private async audit(context: ActionExecutionContext, fields: AuditFields): Promise<void> {
    const store = RequestContext.get();
    if (!store?.actorUserId || !store?.actorRole) {
      return;
    }

    try {
      await this.database.client.insert(aiActionRequests).values({
        workspaceId: context.workspaceId,
        customerId: context.customerId ?? null,
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

  /**
   * `audit()`'s counterpart for `executeForAutomation()` — deliberately
   * does not read `RequestContext` (an event handler has no guaranteed
   * request context, and even where one exists it would belong to
   * whatever unrelated request happened to trigger this tick's event
   * loop, not to this action). `actorUserId`/`actorRole` are written null
   * (doc19 Phase 15 item 7), `correlationId` comes from the caller.
   */
  private async auditSystem(context: ActionExecutionContext, correlationId: string, fields: AuditFields): Promise<void> {
    try {
      await this.database.client.insert(aiActionRequests).values({
        workspaceId: context.workspaceId,
        customerId: context.customerId ?? null,
        actorUserId: null,
        actorRole: null,
        action: fields.action,
        riskLevel: fields.riskLevel,
        permissionDecision: fields.permissionDecision,
        approvalState: fields.approvalState,
        executionStatus: fields.executionStatus,
        inputSummary: fields.inputSummary,
        resultSummary: fields.resultSummary ?? null,
        failureReason: fields.failureReason ?? null,
        correlationId,
      });
    } catch (error) {
      this.logger.event('error', 'Failed to record AI action audit', 'AiActionControlService', {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }
}
