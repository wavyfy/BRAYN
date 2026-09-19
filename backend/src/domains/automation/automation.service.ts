import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, desc, eq } from 'drizzle-orm';
import { automationDefinitions } from '../../database/schema/automation-definitions';
import { automationRuns } from '../../database/schema/automation-runs';
import { DatabaseService } from '../../database/database.service';
import { NotFoundError } from '../../common/errors/app-error';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import type { DomainEvent } from '../../common/events/domain-event';
import { AiActionControlService } from '../ai-action-control/ai-action-control.service';
import { ACTION_REGISTRY, type ActionRegistry } from '../ai-action-control/actions.registry';
import type { RevenueOpportunityCreatedPayload } from '../intelligence-engines/revenue-opportunity.service';
import type { CustomerHealthRecalculatedPayload } from '../intelligence-engines/customer-health.service';
import type { CreateAutomationInput } from './dto/create-automation.schema';
import type { UpdateAutomationInput } from './dto/update-automation.schema';

interface AutomationConditions {
  priorityIn?: string[];
  typeIn?: string[];
}

/**
 * Business Action Automation (doc16; doc19 Phase 15). Phase 1 wires
 * exactly one trigger → action pair — see automation-definitions
 * schema's doc comment for why. This part deliberately omits:
 *
 * - Scheduling/delay (doc19 item 5) — no automation here needs a delay;
 *   adding a scheduler before anything uses it is speculative (doc18).
 * - Retry/recovery (doc19 item 9) — see automation-runs schema's doc
 *   comment; nothing here fails in a way retry would help with today (a
 *   thrown error means a real bug, not a transient failure).
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
    const [automation] = await this.database.client
      .insert(automationDefinitions)
      .values({
        workspaceId,
        name: input.name,
        // Zod's `.default('revenue_opportunity.created')` on createAutomationSchema only applies
        // during ZodValidationPipe's parse — a direct service call (as tests do) bypasses that, so
        // this mirrors the same default here rather than depending on the HTTP boundary having run.
        triggerType: input.triggerType ?? 'revenue_opportunity.created',
        conditions: input.conditions ?? null,
        actionType: 'generate_recommendations',
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

  async listRuns(workspaceId: string, automationId: string) {
    await this.requireAutomation(workspaceId, automationId);

    return this.database.client
      .select()
      .from(automationRuns)
      .where(and(eq(automationRuns.workspaceId, workspaceId), eq(automationRuns.automationId, automationId)))
      .orderBy(desc(automationRuns.createdAt));
  }

  @OnEvent('revenue_opportunity.created')
  async handleRevenueOpportunityCreated(event: DomainEvent<RevenueOpportunityCreatedPayload>): Promise<void> {
    if (!event.workspaceId) return;
    const workspaceId = event.workspaceId;
    const { canonicalCustomerId } = event.payload;

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
        await this.runOne(workspaceId, canonicalCustomerId, definition, event.id, matched, 'Conditions did not match this opportunity.');
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
        await this.runOne(workspaceId, canonicalCustomerId, definition, event.id, matched, 'Conditions did not match this health recalculation.');
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
   */
  private async runOne(
    workspaceId: string,
    canonicalCustomerId: string,
    definition: typeof automationDefinitions.$inferSelect,
    triggerEventId: string,
    conditionsMatched: boolean,
    skipReason: string,
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

    try {
      // Idempotency key derived from infra-assigned ids (this automation + the triggering event),
      // never from workspaceId/action/input content (doc03 rule 5) — a genuine duplicate delivery
      // of the same event to the same automation reuses this key and is safely de-duped;
      // a different event or automation gets its own.
      const idempotencyKey = `${definition.id}:${triggerEventId}`;
      const recommendations = await this.aiActionControl.executeForAutomation(
        this.registry.generateRecommendations,
        {},
        { workspaceId, customerId: canonicalCustomerId },
        idempotencyKey,
        triggerEventId,
      );
      await this.database.client.insert(automationRuns).values({
        workspaceId,
        automationId: definition.id,
        canonicalCustomerId,
        triggerEventId,
        status: 'succeeded',
        result: { recommendationsCount: recommendations.length },
      });
    } catch (error) {
      await this.database.client.insert(automationRuns).values({
        workspaceId,
        automationId: definition.id,
        canonicalCustomerId,
        triggerEventId,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
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
