import { Injectable } from '@nestjs/common';
import { and, count, desc, eq } from 'drizzle-orm';
import { internalNotifications } from '../../database/schema/internal-notifications';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { DatabaseService } from '../../database/database.service';
import { NotFoundError } from '../../common/errors/app-error';

/** Dashboard "Important pending actions" shows the newest 10 (doc24); the API never returns more than this per request. */
export const DEFAULT_NOTIFICATIONS_LIMIT = 10;
export const MAX_NOTIFICATIONS_LIMIT = 50;

/**
 * Internal notifications (doc10 "Merchant / System Notification"; decisions
 * Nov 2, 2026 — see internal-notifications schema). Created only through
 * the `internal_notification.create` action, which Business Action
 * Automation executes via AI Action Control; this service never derives
 * content — type/priority/reason are read from the opportunity on list.
 */
@Injectable()
export class InternalNotificationService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * One notification per opportunity: a second automation firing for the
   * same opportunity gets the existing notification's id back, not a new row.
   * The opportunity must belong to this workspace and customer.
   */
  async createForOpportunity(workspaceId: string, canonicalCustomerId: string, opportunityId: string): Promise<{ id: string; created: boolean }> {
    const [opportunity] = await this.database.client
      .select({ id: revenueOpportunities.id })
      .from(revenueOpportunities)
      .where(
        and(
          eq(revenueOpportunities.workspaceId, workspaceId),
          eq(revenueOpportunities.canonicalCustomerId, canonicalCustomerId),
          eq(revenueOpportunities.id, opportunityId),
        ),
      )
      .limit(1);
    if (!opportunity) {
      throw new NotFoundError('No opportunity with that id exists for this customer.');
    }

    const [inserted] = await this.database.client
      .insert(internalNotifications)
      .values({ workspaceId, opportunityId, canonicalCustomerId })
      .onConflictDoNothing()
      .returning({ id: internalNotifications.id });
    if (inserted) return { id: inserted.id, created: true };

    const [existing] = await this.database.client
      .select({ id: internalNotifications.id })
      .from(internalNotifications)
      .where(and(eq(internalNotifications.workspaceId, workspaceId), eq(internalNotifications.opportunityId, opportunityId)))
      .limit(1);
    return { id: existing.id, created: false };
  }

  /**
   * Newest first, with the workspace total; content resolved from the canonical opportunity.
   * Merged customers are not followed here (doc08 UCIR boundary — this domain doesn't read identity tables);
   * the customer page reports a merged id with its `mergedIntoId`.
   */
  async list(workspaceId: string, limit = DEFAULT_NOTIFICATIONS_LIMIT) {
    const [items, [totals]] = await Promise.all([
      this.database.client
        .select({
          id: internalNotifications.id,
          createdAt: internalNotifications.createdAt,
          opportunityId: internalNotifications.opportunityId,
          canonicalCustomerId: internalNotifications.canonicalCustomerId,
          type: revenueOpportunities.type,
          priority: revenueOpportunities.priority,
          reason: revenueOpportunities.reason,
        })
        .from(internalNotifications)
        .innerJoin(
          revenueOpportunities,
          and(eq(revenueOpportunities.id, internalNotifications.opportunityId), eq(revenueOpportunities.workspaceId, internalNotifications.workspaceId)),
        )
        .where(eq(internalNotifications.workspaceId, workspaceId))
        .orderBy(desc(internalNotifications.createdAt), desc(internalNotifications.id))
        .limit(Math.min(Math.max(limit, 1), MAX_NOTIFICATIONS_LIMIT)),
      this.database.client.select({ total: count() }).from(internalNotifications).where(eq(internalNotifications.workspaceId, workspaceId)),
    ]);
    return { items, total: Number(totals?.total ?? 0) };
  }
}
