import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { recommendations } from '../../database/schema/recommendations';
import { DatabaseService } from '../../database/database.service';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import { RevenueOpportunityService } from './revenue-opportunity.service';

export type RecommendationState = 'active' | 'dismissed' | 'completed';

/**
 * Recommendations (doc10 7.3). See recommendations schema's doc comment
 * for why Phase 1 generates 1:1 from open Revenue Opportunities only.
 *
 * Generation is on-demand (`generate()`) — same reasoning as
 * CustomerHealthService/RevenueOpportunityService for why this isn't
 * event-driven/scheduled yet.
 */
@Injectable()
export class RecommendationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly revenueOpportunityService: RevenueOpportunityService,
  ) {}

  async generate(workspaceId: string, canonicalCustomerId: string) {
    const openOpportunities = await this.revenueOpportunityService.list(workspaceId, canonicalCustomerId);
    const existingOpportunityIds = await this.getExistingOpportunityIds(
      workspaceId,
      openOpportunities.map((opportunity) => opportunity.id),
    );

    const newRows = openOpportunities
      .filter((opportunity) => !existingOpportunityIds.has(opportunity.id))
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
      await this.database.client.insert(recommendations).values(newRows);
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
    const [updated] = await this.database.client
      .update(recommendations)
      .set({ state, closedAt: now, closedReason, updatedAt: now })
      .where(eq(recommendations.id, recommendationId))
      .returning();

    return updated;
  }

  private async getExistingOpportunityIds(workspaceId: string, opportunityIds: string[]): Promise<Set<string>> {
    if (opportunityIds.length === 0) {
      return new Set();
    }

    const rows = await this.database.client
      .select({ sourceOpportunityId: recommendations.sourceOpportunityId })
      .from(recommendations)
      .where(and(eq(recommendations.workspaceId, workspaceId), inArray(recommendations.sourceOpportunityId, opportunityIds)));

    return new Set(rows.map((row) => row.sourceOpportunityId));
  }
}
