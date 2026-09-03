import { Injectable } from '@nestjs/common';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { DatabaseService } from '../../database/database.service';
import { CustomerIntelligenceService, type CustomerRecord } from '../customer-intelligence/customer-intelligence.service';

const WIN_BACK_THRESHOLD_DAYS = 120;
const VIP_ORDER_THRESHOLD = 10;
/** Terminal lifecycle statuses (doc10) — a new candidate is only skipped as a duplicate against a still-open one. */
const TERMINAL_STATUSES = ['converted', 'expired', 'ignored'] as const;

export type OpportunityType = 'reorder' | 'win_back' | 'vip_recognition';
export type OpportunityPriority = 'critical' | 'high' | 'medium' | 'low';

interface OpportunityCandidate {
  type: OpportunityType;
  confidence: number;
  estimatedRevenue: string | null;
  reason: string;
  recommendedAction: string;
}

/**
 * Revenue Opportunity Detector (doc10 7.2). Phase 1: only the three
 * opportunity types computable from Commerce data alone.
 *
 * - `reorder` — customer has a repeat-purchase pattern (2+ orders) and
 *   time since their last order has caught up to their own average
 *   reorder interval.
 * - `win_back` — customer has ordered before but has gone quiet past
 *   `WIN_BACK_THRESHOLD_DAYS`.
 * - `vip_recognition` — customer has placed at least `VIP_ORDER_THRESHOLD`
 *   orders. Order count, not spend: `commerce_orders.totalPrice` has no
 *   currency unit tracked anywhere, so a cross-customer revenue threshold
 *   would be meaningless.
 *
 * Not produced: cross_sell/upsell/bundle (need real product-affinity
 * analysis — not yet spec'd), review_request/referral (no review or
 * referral data exists anywhere in BRAYN yet).
 *
 * Priority (doc10: "Expected Revenue × Confidence × Customer Risk &
 * Engagement State × Business Rules") only has two of those four inputs
 * available — Customer Risk & Engagement State's score is itself withheld
 * (see CustomerHealthService) and no business-rule engine exists — so
 * priority here is confidence adjusted by how the opportunity's estimated
 * revenue compares to this same customer's own average order value (a
 * per-customer relative signal, sidestepping the missing-currency
 * problem an absolute threshold would hit). This is an explicit, narrower
 * formula than doc10's, not a silent substitute — see this part's
 * completion report.
 *
 * ponytail: reorder-interval, win-back threshold, VIP threshold, and
 * priority bucket cutoffs are first-pass heuristics, not product-
 * specified curves — same caveat as CustomerHealthService's signal math.
 *
 * Duplicate prevention (doc10 — "Duplicate opportunities must be
 * prevented"): before creating a candidate, skip it if a non-terminal
 * (open) opportunity of the same type already exists for this customer.
 */
@Injectable()
export class RevenueOpportunityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly customerIntelligenceService: CustomerIntelligenceService,
  ) {}

  async detect(workspaceId: string, canonicalCustomerId: string) {
    const customer = await this.customerIntelligenceService.getCustomer(workspaceId, canonicalCustomerId);
    const candidates = [
      detectReorder(customer),
      detectWinBack(customer),
      detectVipRecognition(customer),
    ].filter((candidate): candidate is OpportunityCandidate => candidate !== null);

    const existingOpenTypes = await this.getOpenTypes(workspaceId, canonicalCustomerId);
    const newCandidates = candidates.filter((candidate) => !existingOpenTypes.has(candidate.type));

    if (newCandidates.length > 0) {
      const avgOrderValue = averageOrderValue(customer);
      await this.database.client.insert(revenueOpportunities).values(
        newCandidates.map((candidate) => ({
          workspaceId,
          canonicalCustomerId,
          type: candidate.type,
          status: 'new' as const,
          priority: computePriority(candidate.confidence, candidate.estimatedRevenue, avgOrderValue),
          estimatedRevenue: candidate.estimatedRevenue,
          confidence: candidate.confidence,
          reason: candidate.reason,
          recommendedAction: candidate.recommendedAction,
        })),
      );
    }

    return this.list(workspaceId, canonicalCustomerId);
  }

  /** Every non-terminal opportunity for this customer, newest first. */
  async list(workspaceId: string, canonicalCustomerId: string) {
    return this.database.client
      .select()
      .from(revenueOpportunities)
      .where(
        and(
          eq(revenueOpportunities.workspaceId, workspaceId),
          eq(revenueOpportunities.canonicalCustomerId, canonicalCustomerId),
          notInArray(revenueOpportunities.status, [...TERMINAL_STATUSES]),
        ),
      )
      .orderBy(desc(revenueOpportunities.createdAt));
  }

  /** Workspace-wide open-opportunity counts by priority (doc11 Merchant Dashboard — "Revenue opportunities"). */
  async countOpenByWorkspace(workspaceId: string): Promise<{ total: number; byPriority: Record<OpportunityPriority, number> }> {
    const rows = await this.database.client
      .select({ priority: revenueOpportunities.priority, count: sql<number>`count(*)` })
      .from(revenueOpportunities)
      .where(and(eq(revenueOpportunities.workspaceId, workspaceId), notInArray(revenueOpportunities.status, [...TERMINAL_STATUSES])))
      .groupBy(revenueOpportunities.priority);

    const byPriority: Record<OpportunityPriority, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    let total = 0;
    for (const row of rows) {
      const count = Number(row.count);
      byPriority[row.priority as OpportunityPriority] = count;
      total += count;
    }

    return { total, byPriority };
  }

  private async getOpenTypes(workspaceId: string, canonicalCustomerId: string): Promise<Set<OpportunityType>> {
    const rows = await this.database.client
      .select({ type: revenueOpportunities.type })
      .from(revenueOpportunities)
      .where(
        and(
          eq(revenueOpportunities.workspaceId, workspaceId),
          eq(revenueOpportunities.canonicalCustomerId, canonicalCustomerId),
          notInArray(revenueOpportunities.status, [...TERMINAL_STATUSES]),
        ),
      );

    return new Set(rows.map((row) => row.type as OpportunityType));
  }
}

function averageOrderValue(customer: CustomerRecord): number | null {
  const { ordersCount, totalSpent } = customer.commerceContext;
  if (ordersCount === 0) {
    return null;
  }
  const total = Number(totalSpent);
  return Number.isFinite(total) ? total / ordersCount : null;
}

function detectReorder(customer: CustomerRecord): OpportunityCandidate | null {
  const { recentOrders, lastOrderAt } = customer.commerceContext;
  if (recentOrders.length < 2 || !lastOrderAt) {
    return null;
  }

  // recentOrders is newest-first — average gap between consecutive orders.
  const gapsMs: number[] = [];
  for (let i = 0; i < recentOrders.length - 1; i++) {
    gapsMs.push(recentOrders[i].createdAt.getTime() - recentOrders[i + 1].createdAt.getTime());
  }
  const avgGapDays = gapsMs.reduce((sum, gap) => sum + gap, 0) / gapsMs.length / (24 * 60 * 60 * 1000);
  const daysSinceLastOrder = (Date.now() - lastOrderAt.getTime()) / (24 * 60 * 60 * 1000);

  if (daysSinceLastOrder < avgGapDays) {
    return null;
  }

  const confidence = Math.min(100, Math.round((recentOrders.length / 5) * 100));
  return {
    type: 'reorder',
    confidence,
    estimatedRevenue: averageOrderValue(customer)?.toFixed(2) ?? null,
    reason: `Customer typically reorders every ~${Math.round(avgGapDays)} day(s); ${Math.round(daysSinceLastOrder)} day(s) have passed since their last order.`,
    recommendedAction: 'Send a reorder reminder for their usual products.',
  };
}

function detectWinBack(customer: CustomerRecord): OpportunityCandidate | null {
  const { ordersCount, lastOrderAt } = customer.commerceContext;
  if (ordersCount === 0 || !lastOrderAt) {
    return null;
  }

  const daysSinceLastOrder = (Date.now() - lastOrderAt.getTime()) / (24 * 60 * 60 * 1000);
  if (daysSinceLastOrder < WIN_BACK_THRESHOLD_DAYS) {
    return null;
  }

  const confidence = Math.min(100, Math.round((daysSinceLastOrder / (WIN_BACK_THRESHOLD_DAYS * 2)) * 100));
  return {
    type: 'win_back',
    confidence,
    estimatedRevenue: averageOrderValue(customer)?.toFixed(2) ?? null,
    reason: `No order in ${Math.round(daysSinceLastOrder)} day(s) — past the ${WIN_BACK_THRESHOLD_DAYS}-day win-back threshold.`,
    recommendedAction: 'Send a win-back offer to re-engage this customer.',
  };
}

function detectVipRecognition(customer: CustomerRecord): OpportunityCandidate | null {
  const { ordersCount } = customer.commerceContext;
  if (ordersCount < VIP_ORDER_THRESHOLD) {
    return null;
  }

  return {
    type: 'vip_recognition',
    confidence: 100,
    estimatedRevenue: null,
    reason: `Customer has placed ${ordersCount} orders — at or above the ${VIP_ORDER_THRESHOLD}-order VIP threshold.`,
    recommendedAction: 'Recognize this customer with a VIP perk or personal outreach.',
  };
}

/** See RevenueOpportunityService's doc comment for why this isn't doc10's full 4-factor formula. */
function computePriority(confidence: number, estimatedRevenue: string | null, avgOrderValue: number | null): OpportunityPriority {
  let score = confidence;

  const revenue = estimatedRevenue ? Number(estimatedRevenue) : null;
  if (revenue !== null && avgOrderValue !== null && avgOrderValue > 0) {
    const ratio = revenue / avgOrderValue;
    score *= ratio >= 1.5 ? 1.2 : ratio < 0.5 ? 0.8 : 1;
  }

  if (score >= 90) return 'critical';
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}
