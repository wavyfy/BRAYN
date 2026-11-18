import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, desc, eq } from 'drizzle-orm';
import { automationDefinitions } from '../../database/schema/automation-definitions';
import { automationRuns } from '../../database/schema/automation-runs';
import { DatabaseService } from '../../database/database.service';
import {
  ApprovalRequiredError,
  ConflictError,
  DuplicateActionRequestError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../common/errors/app-error';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import type { DomainEvent } from '../../common/events/domain-event';
import { AiActionControlService } from '../ai-action-control/ai-action-control.service';
import { ACTION_REGISTRY, type ActionRegistry } from '../ai-action-control/actions.registry';
import type { RevenueOpportunityCreatedPayload } from '../intelligence-engines/revenue-opportunity.service';
import type { CustomerHealthRecalculatedPayload } from '../intelligence-engines/customer-health.service';
import type { CreateAutomationInput } from './dto/create-automation.schema';
import type { UpdateAutomationInput } from './dto/update-automation.schema';

/** Run reason when the same automation + trigger event was already processed. */
export const DUPLICATE_TRIGGER_REASON = 'duplicate trigger';

/** Failures a retry can never fix (doc07 — "Do not repeatedly retry permanent validation or authorization failures"). */
const PERMANENT_FAILURES = [ValidationError, NotFoundError, UnauthorizedError, ApprovalRequiredError];

type AutomationRun = typeof automationRuns.$inferSelect;

interface AutomationConditions {
  priorityIn?: string[];
  typeIn?: string[];
}

/**
 * Business Action Automation (doc16; doc19 Phase 15). Two trigger types
 * and two actions — see automation-definitions schema's doc comment for
 * the allowed pairs. This part deliberately omits:
 *
 * - Scheduling/delay (doc19 item 5) — no automation here needs a delay;
 *   adding a scheduler before anything uses it is speculative (doc18).
 * - Automatic retry (doc19 item 9) — retry is manual only (doc16
 *   decision, Nov 2, 2026): `retryRun()` re-executes a failed run of a
 *   retry-safe action under the same idempotency key, as a new run row.
 *
 * AI Action Control integration (doc19 item 7) is DONE — `runOne()` calls
 * `AiActionControlService.executeForAutomation()` rather than
 * `RecommendationService.generate()` directly (doc16 Core Flow:
 * "Automation → Conditions → AI Action Control/Approval → Action
 * Executor"). `executeForAutomation()` skips the human-role permission
 * check `execute()` has — this listener is system-triggered, not an
 * authenticated request, so there is no actor/role to check; the
 * automation's own `enabled` flag + workspace scope (already the gate on
 * `definitions` below) is the authorization boundary. Still goes through
 * input validation, the policy-check boundary, the `requiresApproval`
 * gate, idempotency, execution, and audit (with a null actor — doc19
 * Phase 15 item 7).
 *
 * Both listeners (`revenue_opportunity.created`, `customer_health.recalculated`)
 * run in-process, in the same tick as their respective emitters
 * (EventBus is synchronous EventEmitter2 — see EventBus's doc comment),
 * so a failure here must never surface as a failure of the emitting
 * service's own caller.
 */
@Injectable()
export class AutomationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly aiActionControl: AiActionControlService,
    @Inject(ACTION_REGISTRY) private readonly registry: ActionRegistry,
    private readonly logger: StructuredLoggerService,
  ) {}

  async create(workspaceId: string, input: CreateAutomationInput) {
    const triggerType = input.triggerType ?? 'revenue_opportunity.created';
    // Same rule as createAutomationSchema's refine, for callers that bypass the HTTP boundary.
    if (input.actionType === 'internal_notification.create' && triggerType !== 'revenue_opportunity.created') {
      throw new ValidationError('Internal notifications can only be triggered by a new revenue opportunity.');
    }
    const [automation] = await this.database.client
      .insert(automationDefinitions)
      .values({
        workspaceId,
        name: input.name,
        // Zod's `.default('revenue_opportunity.created')` on createAutomationSchema only applies
        // during ZodValidationPipe's parse — a direct service call (as tests do) bypasses that, so
        // this mirrors the same default here rather than depending on the HTTP boundary having run.
        triggerType,
        conditions: input.conditions ?? null,
        actionType: input.actionType ?? 'generate_recommendations',
      })
      .returning();

    return automation;
  }

  async list(workspaceId: string) {
    return this.database.client
      .select()
      .from(automationDefinitions)
      .where(eq(automationDefinitions.workspaceId, workspaceId))
      .orderBy(desc(automationDefinitions.createdAt));
  }

  async get(workspaceId: string, automationId: string) {
    return this.requireAutomation(workspaceId, automationId);
  }

  async update(workspaceId: string, automationId: string, input: UpdateAutomationInput) {
    const current = await this.requireAutomation(workspaceId, automationId);

    const [updated] = await this.database.client
      .update(automationDefinitions)
      .set({
        name: input.name ?? current.name,
        conditions: input.conditions !== undefined ? input.conditions : current.conditions,
        enabled: input.enabled ?? current.enabled,
        updatedAt: new Date(),
      })
      .where(eq(automationDefinitions.id, automationId))
      .returning();

    return updated;
  }

  /** Each run with `retryable`: a failed, retryable run of an enabled automation whose trigger hasn't since succeeded and that hasn't been retried already. */
  async listRuns(workspaceId: string, automationId: string) {
    const automation = await this.requireAutomation(workspaceId, automationId);

    const runs = await this.database.client
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.workspaceId, workspaceId), eq(automationRuns.automationId, automationId)))
      .orderBy(desc(automationRuns.createdAt));

    const retrySafe = this.actionDefinition(automation.actionType).retrySafe;
    const succeededEvents = new Set(runs.filter((run) => run.status === 'succeeded').map((run) => run.triggerEventId));
    const retried = new Set(runs.map((run) => run.retryOfRunId));
    return runs.map((run) => ({
      ...run,
      retryable: automation.enabled && retrySafe && canRetry(run) && !succeededEvents.has(run.triggerEventId) && !retried.has(run.id),
    }));
  }

  /**
   * Manual retry (doc16 decision, Nov 2, 2026): re-executes a failed run's stored action input through AI Action
   * Control under the same `${automationId}:${triggerEventId}` key, recording a new run linked by `retryOfRunId`.
   * Refused (409) for a disabled automation (disabling stops all its actions — decision, Nov 18, 2026), a run that
   * isn't failed, a non-retry-safe action, a permanent failure, a trigger that has already succeeded, or while
   * another attempt is running — none of which execute anything.
   */
  async retryRun(workspaceId: string, automationId: string, runId: string): Promise<AutomationRun> {
    const automation = await this.requireAutomation(workspaceId, automationId);
    const [run] = await this.database.client
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.workspaceId, workspaceId), eq(automationRuns.automationId, automationId), eq(automationRuns.id, runId)))
      .limit(1);
    if (!run) throw new NotFoundError('No run with that id exists for this automation.');
    if (!automation.enabled) throw new ConflictError('This automation is disabled. Enable it to retry its runs.');
    if (run.status !== 'failed') throw new ConflictError('Only a failed run can be retried.');
    if (!this.actionDefinition(automation.actionType).retrySafe) throw new ConflictError("This automation's action can't be retried safely.");
    if (!canRetry(run)) throw new ConflictError('This run failed permanently and cannot be retried.');

    const actionInput = run.actionInput as Record<string, unknown>;
    const retryRow = {
      workspaceId,
      automationId,
      canonicalCustomerId: run.canonicalCustomerId,
      triggerEventId: run.triggerEventId,
      actionInput,
      retryOfRunId: run.id,
    };
    try {
      const result = await this.executeAction(
        automation.actionType,
        { workspaceId, customerId: run.canonicalCustomerId },
        actionInput,
        `${automation.id}:${run.triggerEventId}`,
        run.triggerEventId,
      );
      const [created] = await this.database.client.insert(automationRuns).values({ ...retryRow, status: 'succeeded', result }).returning();
      return created;
    } catch (error) {
      if (error instanceof DuplicateActionRequestError) throw new ConflictError('This trigger has already been executed successfully; nothing was retried.');
      // Another attempt holds the key right now: nothing ran here.
      if (error instanceof ConflictError) throw error;
      const [created] = await this.database.client
        .insert(automationRuns)
        .values({ ...retryRow, status: 'failed', reason: errorMessage(error), result: { retryable: this.isRetryable(automation.actionType, error) } })
        .returning();
      return created;
    }
  }

  @OnEvent('revenue_opportunity.created')
  async handleRevenueOpportunityCreated(event: DomainEvent<RevenueOpportunityCreatedPayload>): Promise<void> {
    if (!event.workspaceId) return;
    const workspaceId = event.workspaceId;
    const { canonicalCustomerId, opportunityId } = event.payload;

    const definitions = await this.database.client
      .select()
      .from(automationDefinitions)
      .where(
        and(
          eq(automationDefinitions.workspaceId, workspaceId),
          eq(automationDefinitions.triggerType, 'revenue_opportunity.created'),
          eq(automationDefinitions.enabled, true),
        ),
      );

    for (const definition of definitions) {
      try {
        const matched = matchesConditions(definition.conditions as AutomationConditions | null, event.payload);
        await this.runOne(workspaceId, canonicalCustomerId, definition, event.id, matched, 'Conditions did not match this opportunity.', opportunityId);
      } catch (error) {
        // A run failure is this automation's own concern (recorded below) — it must never
        // propagate back into the detect() call that emitted this event (doc07 tenant/
        // processing boundary: consumers don't affect producers).
        this.logger.event('error', `Automation ${definition.id} run threw unexpectedly`, 'AutomationService', {
          automationId: definition.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Doc16 "Triggers" lists "Customer Risk & Engagement State changes" —
   * `CustomerHealthService.recalculate()` already emits this event (doc10
   * — "Health changes should publish events for dependent intelligence
   * and automation"); this is the first consumer. Same routing shape as
   * `handleRevenueOpportunityCreated` — see `matchesHealthConditions` for
   * why conditions are accepted but not evaluated for this trigger.
   */
  @OnEvent('customer_health.recalculated')
  async handleCustomerHealthRecalculated(event: DomainEvent<CustomerHealthRecalculatedPayload>): Promise<void> {
    if (!event.workspaceId) return;
    const workspaceId = event.workspaceId;
    const { canonicalCustomerId } = event.payload;

    const definitions = await this.database.client
      .select()
      .from(automationDefinitions)
      .where(
        and(
          eq(automationDefinitions.workspaceId, workspaceId),
          eq(automationDefinitions.triggerType, 'customer_health.recalculated'),
          eq(automationDefinitions.enabled, true),
        ),
      );

    for (const definition of definitions) {
      try {
        const matched = matchesHealthConditions();
        await this.runOne(workspaceId, canonicalCustomerId, definition, event.id, matched, 'Conditions did not match this health recalculation.', null);
      } catch (error) {
        this.logger.event('error', `Automation ${definition.id} run threw unexpectedly`, 'AutomationService', {
          automationId: definition.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Shared by both trigger handlers — condition-matching is computed by
   * the caller (each trigger's payload shape differs), this only owns
   * the skip/execute/record mechanics common to every trigger type.
   * `opportunityId` is the triggering opportunity (null for health triggers).
   */
  private async runOne(
    workspaceId: string,
    canonicalCustomerId: string,
    definition: typeof automationDefinitions.$inferSelect,
    triggerEventId: string,
    conditionsMatched: boolean,
    skipReason: string,
    opportunityId: string | null,
  ): Promise<void> {
    if (!conditionsMatched) {
      await this.database.client.insert(automationRuns).values({
        workspaceId,
        automationId: definition.id,
        canonicalCustomerId,
        triggerEventId,
        status: 'skipped',
        reason: skipReason,
      });
      return;
    }

    let actionInput: Record<string, unknown> | null = null;
    try {
      actionInput = this.buildActionInput(definition.actionType, opportunityId);
      // Idempotency key derived from infra-assigned ids (this automation + the triggering event),
      // never from workspaceId/action/input content (doc03 rule 5) — a genuine duplicate delivery
      // of the same event to the same automation reuses this key and is safely de-duped;
      // a different event or automation gets its own. A manual retry reuses it too.
      const idempotencyKey = `${definition.id}:${triggerEventId}`;
      const result = await this.executeAction(definition.actionType, { workspaceId, customerId: canonicalCustomerId }, actionInput, idempotencyKey, triggerEventId);
      await this.database.client.insert(automationRuns).values({
        workspaceId,
        automationId: definition.id,
        canonicalCustomerId,
        triggerEventId,
        status: 'succeeded',
        result,
        actionInput,
      });
    } catch (error) {
      // This automation + trigger event already executed (for a retry-safe action: completed): nothing ran, so it's skipped, not failed.
      const duplicate = error instanceof DuplicateActionRequestError;
      await this.database.client.insert(automationRuns).values({
        workspaceId,
        automationId: definition.id,
        canonicalCustomerId,
        triggerEventId,
        status: duplicate ? 'skipped' : 'failed',
        reason: duplicate ? DUPLICATE_TRIGGER_REASON : errorMessage(error),
        result: duplicate ? null : { retryable: this.isRetryable(definition.actionType, error) },
        actionInput,
      });
    }
  }

  /** Built from the server-emitted trigger event only — never from AI or client input (#9 decision, Nov 2, 2026). */
  private buildActionInput(actionType: AutomationActionType, opportunityId: string | null): Record<string, unknown> {
    if (actionType === 'internal_notification.create') {
      // Create-time validation rejects any other trigger for this action; this guards rows written before it.
      if (!opportunityId) throw new ValidationError('internal_notification.create requires a revenue_opportunity.created trigger.');
      return { opportunityId };
    }
    return {};
  }

  private actionDefinition(actionType: AutomationActionType) {
    return actionType === 'internal_notification.create' ? this.registry.internalNotificationCreate : this.registry.generateRecommendations;
  }

  private isRetryable(actionType: AutomationActionType, error: unknown): boolean {
    return this.actionDefinition(actionType).retrySafe && !PERMANENT_FAILURES.some((permanent) => error instanceof permanent);
  }

  /** Dispatches on the definition's `actionType`, always through AI Action Control; returns the run's `result`. */
  private async executeAction(
    actionType: AutomationActionType,
    context: { workspaceId: string; customerId: string },
    actionInput: Record<string, unknown>,
    idempotencyKey: string,
    triggerEventId: string,
  ): Promise<Record<string, unknown>> {
    if (actionType === 'internal_notification.create') {
      const notification = await this.aiActionControl.executeForAutomation(
        this.registry.internalNotificationCreate,
        actionInput,
        context,
        idempotencyKey,
        triggerEventId,
      );
      return { notificationId: notification.id };
    }
    const recommendations = await this.aiActionControl.executeForAutomation(this.registry.generateRecommendations, actionInput, context, idempotencyKey, triggerEventId);
    return { recommendationsCount: recommendations.length };
  }

  private async requireAutomation(workspaceId: string, automationId: string) {
    const [automation] = await this.database.client
      .select()
      .from(automationDefinitions)
      .where(and(eq(automationDefinitions.workspaceId, workspaceId), eq(automationDefinitions.id, automationId)))
      .limit(1);

    if (!automation) {
      throw new NotFoundError('No automation with that id exists in this workspace.');
    }

    return automation;
  }
}

function matchesConditions(conditions: AutomationConditions | null, payload: RevenueOpportunityCreatedPayload): boolean {
  if (!conditions) return true;
  if (conditions.priorityIn && !conditions.priorityIn.includes(payload.priority)) return false;
  if (conditions.typeIn && !conditions.typeIn.includes(payload.type)) return false;
  return true;
}

/**
 * Doc16 "Conditions" lists "Customer Risk & Engagement State" as an
 * available signal, but no field on `CustomerHealthRecalculatedPayload`
 * is safe to filter on today: `score`/`healthCategory`/`trend` are
 * always `null` (`CustomerHealthService` deliberately withholds them —
 * only 2 of 6 spec'd signal weights are available, see its own doc
 * comment), and `reasonCodes` is free text, not a stable condition
 * target. The canonical docs don't define health-specific condition
 * semantics beyond naming the signal source, so — per this slice's
 * explicit instruction not to invent condition language — every enabled
 * `customer_health.recalculated` automation fires unconditionally for
 * now. `conditions` is still accepted on such a definition (the column
 * is shared) but never evaluated. Revisit once score/category/trend are
 * actually populated by a future Phase 7 slice.
 */
function matchesHealthConditions(): boolean {
  return true;
}

type AutomationActionType = (typeof automationDefinitions.$inferSelect)['actionType'];

/** A failed run whose stored input can be re-executed and whose failure wasn't permanent. */
function canRetry(run: AutomationRun): boolean {
  return run.status === 'failed' && run.actionInput !== null && (run.result as { retryable?: boolean } | null)?.retryable === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
