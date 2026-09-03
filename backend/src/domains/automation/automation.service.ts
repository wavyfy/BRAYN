import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, desc, eq } from 'drizzle-orm';
import { automationDefinitions } from '../../database/schema/automation-definitions';
import { automationRuns } from '../../database/schema/automation-runs';
import { DatabaseService } from '../../database/database.service';
import { NotFoundError } from '../../common/errors/app-error';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import type { DomainEvent } from '../../common/events/domain-event';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import type { RevenueOpportunityCreatedPayload } from '../intelligence-engines/revenue-opportunity.service';
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
 * - AI Action Control integration (doc19 item 7) — doesn't exist yet
 *   (doc19 Phase 14). `generate_recommendations` is Phase 1's only
 *   action precisely because it's read/derive-only and low-risk (doc14 —
 *   "Low risk → automatic execution where permitted"): it writes
 *   `recommendations` rows, the same effect a merchant can already
 *   trigger by hand (RecommendationService.generate), so no new
 *   authorization surface is created by automating it.
 * - Retry/recovery (doc19 item 9) — see automation-runs schema's doc
 *   comment; nothing here fails in a way retry would help with today (a
 *   thrown error means a real bug, not a transient failure).
 *
 * The `revenue_opportunity.created` listener runs in-process, in the
 * same tick as `RevenueOpportunityService.detect()` (EventBus is
 * synchronous EventEmitter2 — see EventBus's doc comment), so a failure
 * here must never surface as a failure of `detect()`'s own caller.
 */
@Injectable()
export class AutomationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly recommendationService: RecommendationService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async create(workspaceId: string, input: CreateAutomationInput) {
    const [automation] = await this.database.client
      .insert(automationDefinitions)
      .values({
        workspaceId,
        name: input.name,
        triggerType: 'revenue_opportunity.created',
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
        await this.runOne(workspaceId, canonicalCustomerId, definition, event);
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

  private async runOne(
    workspaceId: string,
    canonicalCustomerId: string,
    definition: typeof automationDefinitions.$inferSelect,
    event: DomainEvent<RevenueOpportunityCreatedPayload>,
  ): Promise<void> {
    if (!matchesConditions(definition.conditions as AutomationConditions | null, event.payload)) {
      await this.database.client.insert(automationRuns).values({
        workspaceId,
        automationId: definition.id,
        canonicalCustomerId,
        triggerEventId: event.id,
        status: 'skipped',
        reason: 'Conditions did not match this opportunity.',
      });
      return;
    }

    try {
      const recommendations = await this.recommendationService.generate(workspaceId, canonicalCustomerId);
      await this.database.client.insert(automationRuns).values({
        workspaceId,
        automationId: definition.id,
        canonicalCustomerId,
        triggerEventId: event.id,
        status: 'succeeded',
        result: { recommendationsCount: recommendations.length },
      });
    } catch (error) {
      await this.database.client.insert(automationRuns).values({
        workspaceId,
        automationId: definition.id,
        canonicalCustomerId,
        triggerEventId: event.id,
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
