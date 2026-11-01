import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { recommendations } from '../../database/schema/recommendations';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { DatabaseService } from '../../database/database.service';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import type { DomainEvent } from '../../common/events/domain-event';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { RevenueOpportunityService, TERMINAL_STATUSES } from './revenue-opportunity.service';

export type RecommendationState = 'active' | 'dismissed' | 'completed';

/** `closedReason` on an opportunity ignored because its recommendation was dismissed. */
export const DISMISSED_CLOSED_REASON = 'recommendation_dismissed';

/** Doc10 lifecycle statuses an opportunity may still move to `executed` from; terminal or already-executed ones are left as they are. */
const PRE_EXECUTION_STATUSES = ['new', 'recommended', 'scheduled'] as const;

/**
 * Recommendations (doc10 7.3). See recommendations schema's doc comment
 * for why Phase 1 generates 1:1 from open Revenue Opportunities only.
 *
 * Generated on demand (`generate()`) and automatically (Milestone #5 D5):
 * every commerce event that changes a customer's history and every health
 * recalculation re-runs opportunity detection, then recommendation
 * generation, for that customer. Both steps skip what already exists, so a
 * repeated or concurrent evaluation creates nothing twice. The daily
 * scheduled run (IntelligenceDailyRunService) calls detect() then
 * generate() for every customer.
 */
@Injectable()
export class RecommendationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly revenueOpportunityService: RevenueOpportunityService,
    private readonly logger: StructuredLoggerService,
  ) {}

  /**
   * In-process off the emitter (synchronous EventBus), so a failure is logged and never
   * propagates to the commerce write or health recalculation that emitted the event —
   * same fire-and-forget boundary as CustomerHealthService.handleCommerceEvent.
   */
  @OnEvent('order.created')
  @OnEvent('order.cancelled')
  @OnEvent('refund.processed')
  @OnEvent('customer_health.recalculated')
  async handleEvaluationTrigger(event: DomainEvent<{ canonicalCustomerId?: string | null }>): Promise<void> {
    const { canonicalCustomerId } = event.payload;
    if (!event.workspaceId || !canonicalCustomerId) return;

    try {
      // #8: a new order can convert an executed opportunity — checked before detection re-evaluates the customer.
      if (event.type === 'order.created') await this.revenueOpportunityService.evaluateConversions(event.workspaceId, canonicalCustomerId);
      await this.revenueOpportunityService.detect(event.workspaceId, canonicalCustomerId);
      await this.generate(event.workspaceId, canonicalCustomerId);
    } catch (error) {
      this.logger.event('error', `Opportunity/recommendation evaluation on ${event.type} threw unexpectedly`, 'RecommendationService', {
        canonicalCustomerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async generate(workspaceId: string, canonicalCustomerId: string) {
    const openOpportunities = await this.revenueOpportunityService.list(workspaceId, canonicalCustomerId);
    const existingStates = await this.getExistingRecommendationStates(
      workspaceId,
      openOpportunities.map((opportunity) => opportunity.id),
    );

    const newRows = openOpportunities
      .filter((opportunity) => !existingStates.has(opportunity.id))
      .map((opportunity) => ({
        workspaceId,
        canonicalCustomerId,
        sourceOpportunityId: opportunity.id,
        text: opportunity.recommendedAction,
        supportingSignals: {
          opportunityType: opportunity.type,
          confidence: opportunity.confidence,
          priority: opportunity.priority,
          estimatedRevenue: opportunity.estimatedRevenue,
          reason: opportunity.reason,
        },
        state: 'active' as const,
      }));

    if (newRows.length > 0) {
      // A concurrent evaluation may have inserted the same opportunity's recommendation; the unique index makes that a no-op.
      await this.database.client.insert(recommendations).values(newRows).onConflictDoNothing();
    }

    // Doc10 lifecycle: an opportunity whose recommendation is surfaced (active) is `recommended`. Only `new` moves, so a
    // concurrent expiry or a later status is never overwritten; a dismissed/completed recommendation's opportunity is not touched.
    const surfacedOpportunityIds = openOpportunities
      .map((opportunity) => opportunity.id)
      .filter((id) => !existingStates.has(id) || existingStates.get(id) === 'active');
    if (surfacedOpportunityIds.length > 0) {
      await this.database.client
        .update(revenueOpportunities)
        .set({ status: 'recommended', updatedAt: new Date() })
        .where(
          and(
            eq(revenueOpportunities.workspaceId, workspaceId),
            eq(revenueOpportunities.canonicalCustomerId, canonicalCustomerId),
            inArray(revenueOpportunities.id, surfacedOpportunityIds),
            eq(revenueOpportunities.status, 'new'),
          ),
        );
    }

    return this.list(workspaceId, canonicalCustomerId);
  }

  /** Active recommendations for this customer, newest first. */
  async list(workspaceId: string, canonicalCustomerId: string) {
    return this.database.client
      .select()
      .from(recommendations)
      .where(
        and(
          eq(recommendations.workspaceId, workspaceId),
          eq(recommendations.canonicalCustomerId, canonicalCustomerId),
          eq(recommendations.state, 'active'),
        ),
      )
      .orderBy(desc(recommendations.createdAt));
  }

  async dismiss(workspaceId: string, canonicalCustomerId: string, recommendationId: string, reason?: string) {
    return this.closeState(workspaceId, canonicalCustomerId, recommendationId, 'dismissed', reason ?? null);
  }

  async complete(workspaceId: string, canonicalCustomerId: string, recommendationId: string) {
    return this.closeState(workspaceId, canonicalCustomerId, recommendationId, 'completed', null);
  }

  /** Workspace-wide active count (doc11 Merchant Dashboard). */
  async countActiveByWorkspace(workspaceId: string): Promise<number> {
    const [row] = await this.database.client
      .select({ count: sql<number>`count(*)` })
      .from(recommendations)
      .where(and(eq(recommendations.workspaceId, workspaceId), eq(recommendations.state, 'active')));

    return Number(row?.count ?? 0);
  }

  private async closeState(
    workspaceId: string,
    canonicalCustomerId: string,
    recommendationId: string,
    state: Exclude<RecommendationState, 'active'>,
    closedReason: string | null,
  ) {
    const [existing] = await this.database.client
      .select()
      .from(recommendations)
      .where(
        and(
          eq(recommendations.workspaceId, workspaceId),
          eq(recommendations.canonicalCustomerId, canonicalCustomerId),
          eq(recommendations.id, recommendationId),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new NotFoundError('No recommendation with that id exists for this customer.');
    }
    if (existing.state !== 'active') {
      throw new ConflictError(`Recommendation is already ${existing.state}.`);
    }

    const now = new Date();
    return this.database.transaction(async (tx) => {
      // The `active` guard makes a racing second close a conflict instead of a silent re-close.
      const [updated] = await tx
        .update(recommendations)
        .set({ state, closedAt: now, closedReason, updatedAt: now })
        .where(and(eq(recommendations.id, recommendationId), eq(recommendations.state, 'active')))
        .returning();
      if (!updated) {
        throw new ConflictError('Recommendation is no longer active.');
      }

      // Doc10 lifecycle, own source opportunity only: dismissal ignores it (terminal; detection recreates it only on
      // changed evidence — isSuppressedByIgnored / the website post-closure rule); completion executes it.
      if (state === 'dismissed') {
        await tx
          .update(revenueOpportunities)
          .set({ status: 'ignored', closedAt: now, closedReason: DISMISSED_CLOSED_REASON, updatedAt: now })
          .where(
            and(
              eq(revenueOpportunities.workspaceId, workspaceId),
              eq(revenueOpportunities.canonicalCustomerId, canonicalCustomerId),
              eq(revenueOpportunities.id, existing.sourceOpportunityId),
              notInArray(revenueOpportunities.status, [...TERMINAL_STATUSES]),
            ),
          );
      } else {
        await tx
          .update(revenueOpportunities)
          .set({ status: 'executed', updatedAt: now })
          .where(
            and(
              eq(revenueOpportunities.workspaceId, workspaceId),
              eq(revenueOpportunities.canonicalCustomerId, canonicalCustomerId),
              eq(revenueOpportunities.id, existing.sourceOpportunityId),
              inArray(revenueOpportunities.status, [...PRE_EXECUTION_STATUSES]),
            ),
          );
      }

      return updated;
    });
  }

  /** Opportunity id → its existing recommendation's state. */
  private async getExistingRecommendationStates(workspaceId: string, opportunityIds: string[]): Promise<Map<string, RecommendationState>> {
    if (opportunityIds.length === 0) {
      return new Map();
    }

    const rows = await this.database.client
      .select({ sourceOpportunityId: recommendations.sourceOpportunityId, state: recommendations.state })
      .from(recommendations)
      .where(and(eq(recommendations.workspaceId, workspaceId), inArray(recommendations.sourceOpportunityId, opportunityIds)));

    return new Map(rows.map((row) => [row.sourceOpportunityId, row.state]));
  }
}
