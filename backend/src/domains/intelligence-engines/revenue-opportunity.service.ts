import { Injectable } from '@nestjs/common';
import { and, eq, desc, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders, orderPlacedAt } from '../../database/schema/commerce-orders';
import { commerceOrderLineItems } from '../../database/schema/commerce-order-line-items';
import { commerceProductVariants } from '../../database/schema/commerce-product-variants';
import { DatabaseService } from '../../database/database.service';
import { createEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { CustomerIntelligenceService, type CustomerRecord, type WebsiteProductIntent } from '../customer-intelligence/customer-intelligence.service';
import { CustomerHealthService, type HealthCategory } from './customer-health.service';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Doc10 opportunity lifecycle: "Merchant / System Notification" after detection (doc16 trigger: "Revenue opportunities"). */
export interface RevenueOpportunityCreatedPayload {
  opportunityId: string;
  canonicalCustomerId: string;
  type: OpportunityType;
  priority: OpportunityPriority;
  estimatedRevenue: string | null;
  confidence: number;
}

const WIN_BACK_THRESHOLD_DAYS = 120;
const VIP_ORDER_THRESHOLD = 10;
/** Terminal lifecycle statuses (doc10) — a new candidate is only skipped as a duplicate against a still-open one. */
export const TERMINAL_STATUSES = ['converted', 'expired', 'ignored'] as const;

/**
 * Approved thresholds for cross_sell/bundle/upsell (Phase 7 product-affinity
 * slice — approved heuristic proposal, not doc10-derived). First-pass
 * product decisions, same status as WIN_BACK_THRESHOLD_DAYS/VIP_ORDER_THRESHOLD
 * above — centralized here so they can be tuned later without touching
 * detection logic.
 */
const CROSS_SELL_MIN_CO_OCCURRING_ORDERS = 3;
const CROSS_SELL_MIN_RATIO = 0.15;
const BUNDLE_MIN_CO_OCCURRING_ORDERS = 5;
const BUNDLE_MIN_RATIO = 0.4;
/** Below this many total workspace orders, no affinity signal is trusted (too little data). */
const MIN_WORKSPACE_ORDERS_FOR_AFFINITY = 20;
const UPSELL_CONFIDENCE_SINGLE_CANDIDATE = 80;
const UPSELL_CONFIDENCE_MULTIPLE_CANDIDATES = 60;

// Website-derived cross_sell (Milestone #5 Release 3 — user decisions, Nov 1, 2026).
const DAY_MS = 24 * 60 * 60 * 1000;
export const WEBSITE_EVIDENCE_WINDOW_MS = 7 * DAY_MS;
export const WEBSITE_VIEW_MIN_VIEWS = 3;
export const WEBSITE_VIEW_MIN_SESSIONS = 2;
export const WEBSITE_CART_WAIT_MS = DAY_MS;
const WEBSITE_CONFIDENCE_VIEWS = 60; // medium evidence
const WEBSITE_CONFIDENCE_CART = 80; // high evidence
const WEBSITE_EXPIRED_REASON = 'Website evidence no longer fresh (7 days).';

export interface WebsiteQualification {
  kind: 'cart' | 'views';
  quantity: number;
  evidenceAt: Date;
  viewCount: number;
  sessionCount: number;
}

/**
 * Applies the Release 3 rules to one product's evidence, counting only events after `evidenceAfter`
 * (the earlier website opportunity's closure — so a closed one returns only on new evidence).
 * Cart: added ≥24 h ago with no purchase since. Views: ≥3 views across ≥2 distinct sessions in the
 * window. A product the customer ever bought never qualifies — cross_sell offers something new.
 */
export function qualifyWebsiteIntent(intent: WebsiteProductIntent, now: Date, evidenceAfter: Date | null): WebsiteQualification | null {
  if (intent.lastPurchasedAt) return null;
  const after = (at: Date) => !evidenceAfter || at > evidenceAfter;

  const carts = intent.cartAdds.filter((cart) => after(cart.occurredAt) && now.getTime() - cart.occurredAt.getTime() >= WEBSITE_CART_WAIT_MS);
  if (carts.length > 0) {
    const latest = carts.reduce((a, b) => (b.occurredAt > a.occurredAt ? b : a));
    return { kind: 'cart', quantity: latest.quantity, evidenceAt: latest.occurredAt, viewCount: 0, sessionCount: 0 };
  }

  const views = intent.views.filter((view) => after(view.occurredAt));
  const sessionCount = new Set(views.map((view) => view.sessionId)).size;
  if (views.length < WEBSITE_VIEW_MIN_VIEWS || sessionCount < WEBSITE_VIEW_MIN_SESSIONS) return null;
  const evidenceAt = views.reduce((a, b) => (b.occurredAt > a.occurredAt ? b : a)).occurredAt;
  return { kind: 'views', quantity: 1, evidenceAt, viewCount: views.length, sessionCount };
}

/** Cart beats views; then more sessions, more views, more recent. */
function strongerQualification(a: WebsiteQualification, b: WebsiteQualification): number {
  if (a.kind !== b.kind) return a.kind === 'cart' ? -1 : 1;
  return b.sessionCount - a.sessionCount || b.viewCount - a.viewCount || b.evidenceAt.getTime() - a.evidenceAt.getTime();
}

export type OpportunityType = 'reorder' | 'win_back' | 'vip_recognition' | 'cross_sell' | 'bundle' | 'upsell';
export type OpportunityPriority = 'critical' | 'high' | 'medium' | 'low';

interface OpportunityCandidate {
  type: OpportunityType;
  confidence: number;
  estimatedRevenue: string | null;
  reason: string;
  recommendedAction: string;
  /** Website-derived only. */
  evidenceProductId?: string;
  evidenceAt?: Date;
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
 * - `cross_sell` / `bundle` — both read from the same product-affinity
 *   signal (workspace-wide same-order co-occurrence of two products),
 *   differing only by threshold: `bundle` requires the stronger pair
 *   (5+ co-occurring orders, 40%+ ratio), `cross_sell` the weaker one
 *   (3+, 15%+). A pair meeting the bundle bar surfaces as `bundle` only,
 *   never also as `cross_sell` (approved scope). Requires the workspace
 *   to have at least `MIN_WORKSPACE_ORDERS_FOR_AFFINITY` total orders
 *   before any affinity is trusted. At most one candidate total is
 *   produced by this detector (the single highest-ratio qualifying pair),
 *   matching `getOpenTypes()`'s type-level (not per-product) dedup.
 * - `upsell` — customer purchased a variant; the *nearest* higher-priced
 *   sibling variant of the same product (not the most expensive) is the
 *   candidate, skipping any sibling already purchased or out of stock
 *   (`inventoryQuantity === 0`; `null` is treated as available — nothing
 *   in the current data ever guarantees a real number here). Evaluated
 *   most-recently-purchased-product first, stopping at the first product
 *   with a qualifying candidate.
 *
 * - website `cross_sell` (Milestone #5 Release 3) — only when the caller
 *   passes `includeWebsite` (the scheduled daily run; no real-time
 *   creation): a never-purchased product with cart intent (≥24 h, no
 *   purchase) or repeated views (≥3 across ≥2 sessions in 7 days) — see
 *   qualifyWebsiteIntent. Evidence comes normalized from
 *   CustomerIntelligenceService.getWebsiteProductIntent. Carries
 *   `evidenceProductId`/`evidenceAt`: an open one is refreshed while its
 *   evidence stays fresh and expires 7 days after it goes stale (its
 *   active recommendation dismissed, as on merge); a closed one returns
 *   only when the rule qualifies again on events after its closure. A
 *   commerce `cross_sell` candidate in the same evaluation wins (one open
 *   opportunity per type).
 *
 * Not produced: review_request/referral (no review or referral data
 * exists anywhere in BRAYN yet).
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
 *
 * Each newly created opportunity emits `revenue_opportunity.created`
 * (doc10 lifecycle — "Merchant / System Notification"; doc16 trigger
 * "Revenue opportunities"), so Business Action Automation has a real
 * trigger once one is built. No handler exists yet.
 */
@Injectable()
export class RevenueOpportunityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly customerIntelligenceService: CustomerIntelligenceService,
    private readonly eventBus: EventBus,
    private readonly customerHealthService: CustomerHealthService,
  ) {}

  async detect(workspaceId: string, canonicalCustomerId: string, options: { includeWebsite?: boolean } = {}) {
    const customer = await this.customerIntelligenceService.getCustomer(workspaceId, canonicalCustomerId);
    const now = new Date();
    const websiteIntents = options.includeWebsite
      ? await this.customerIntelligenceService.getWebsiteProductIntent(workspaceId, canonicalCustomerId, new Date(now.getTime() - WEBSITE_EVIDENCE_WINDOW_MS), now)
      : null;

    // A customer with zero commerce orders trivially owns zero products, so
    // affinity/upsell can only ever return null — skip the queries entirely
    // rather than run them for a guaranteed-empty result.
    const hasOrders = customer.commerceContext.ordersCount > 0;
    const affinityCandidate = hasOrders ? await this.detectAffinityOpportunity(workspaceId, canonicalCustomerId) : null;
    const upsellCandidate = hasOrders ? await this.detectUpsell(workspaceId, canonicalCustomerId) : null;

    const candidates = [
      detectReorder(customer),
      detectWinBack(customer),
      detectVipRecognition(customer),
      affinityCandidate,
      upsellCandidate,
    ].filter((candidate): candidate is OpportunityCandidate => candidate !== null);

    const healthCategory = (await this.customerHealthService.findCurrent(workspaceId, canonicalCustomerId))?.healthCategory ?? null;
    const avgOrderValue = averageOrderValue(customer);

    // Automatic evaluation (Milestone #5 D5) can run concurrently for one customer (order event + the
    // health event it causes); a per-customer transaction lock makes the open-type check and insert atomic.
    const created = await this.database.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`revenue_opportunity:${workspaceId}:${canonicalCustomerId}`}))`);
      if (websiteIntents) {
        const websiteCandidate = await this.maintainWebsiteOpportunities(tx, workspaceId, canonicalCustomerId, websiteIntents, now);
        if (websiteCandidate && !candidates.some((candidate) => candidate.type === websiteCandidate.type)) candidates.push(websiteCandidate);
      }
      const existingOpenTypes = await this.getOpenTypes(workspaceId, canonicalCustomerId, tx);
      const newCandidates = candidates.filter((candidate) => !existingOpenTypes.has(candidate.type));
      if (newCandidates.length === 0) return [];

      return tx
        .insert(revenueOpportunities)
        .values(
          newCandidates.map((candidate) => ({
            workspaceId,
            canonicalCustomerId,
            type: candidate.type,
            status: 'new' as const,
            priority: computePriority(candidate.confidence, candidate.estimatedRevenue, avgOrderValue, candidate.type, healthCategory),
            estimatedRevenue: candidate.estimatedRevenue,
            confidence: candidate.confidence,
            reason: candidate.reason,
            recommendedAction: candidate.recommendedAction,
            evidenceProductId: candidate.evidenceProductId ?? null,
            evidenceAt: candidate.evidenceAt ?? null,
          })),
        )
        .returning();
    });

    // Emitted after commit, so a handler never sees an opportunity that could still roll back.
    for (const opportunity of created) {
      this.eventBus.emit(
        createEvent<RevenueOpportunityCreatedPayload>({
          type: 'revenue_opportunity.created',
          workspaceId,
          entityId: opportunity.id,
          payload: {
            opportunityId: opportunity.id,
            canonicalCustomerId,
            type: opportunity.type as OpportunityType,
            priority: opportunity.priority as OpportunityPriority,
            estimatedRevenue: opportunity.estimatedRevenue,
            confidence: opportunity.confidence,
          },
        }),
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

  /**
   * Inside detect()'s per-customer lock: refreshes open website opportunities whose evidence still
   * qualifies, expires stale ones (dismissing their active recommendation), then returns the strongest
   * new website candidate — applying the recreation rule per product. Null when nothing qualifies.
   */
  private async maintainWebsiteOpportunities(
    tx: NodePgDatabase,
    workspaceId: string,
    canonicalCustomerId: string,
    intents: WebsiteProductIntent[],
    now: Date,
  ): Promise<OpportunityCandidate | null> {
    const websiteRows = await tx
      .select({
        id: revenueOpportunities.id,
        status: revenueOpportunities.status,
        evidenceProductId: revenueOpportunities.evidenceProductId,
        evidenceAt: revenueOpportunities.evidenceAt,
        closedAt: revenueOpportunities.closedAt,
        updatedAt: revenueOpportunities.updatedAt,
      })
      .from(revenueOpportunities)
      .where(
        and(
          eq(revenueOpportunities.workspaceId, workspaceId),
          eq(revenueOpportunities.canonicalCustomerId, canonicalCustomerId),
          isNotNull(revenueOpportunities.evidenceAt),
        ),
      );
    const intentByProduct = new Map(intents.map((intent) => [intent.productId, intent]));
    const isTerminal = (status: string) => (TERMINAL_STATUSES as readonly string[]).includes(status);

    for (const row of websiteRows.filter((r) => !isTerminal(r.status) && r.evidenceProductId)) {
      const intent = intentByProduct.get(row.evidenceProductId!);
      const fresh = intent ? qualifyWebsiteIntent(intent, now, null) : null;
      if (fresh && fresh.evidenceAt > row.evidenceAt!) {
        await tx.update(revenueOpportunities).set({ evidenceAt: fresh.evidenceAt, updatedAt: now }).where(eq(revenueOpportunities.id, row.id));
      }
    }

    const expired = await tx
      .update(revenueOpportunities)
      .set({ status: 'expired', closedAt: now, closedReason: WEBSITE_EXPIRED_REASON, updatedAt: now })
      .where(
        and(
          eq(revenueOpportunities.workspaceId, workspaceId),
          eq(revenueOpportunities.canonicalCustomerId, canonicalCustomerId),
          lt(revenueOpportunities.evidenceAt, new Date(now.getTime() - WEBSITE_EVIDENCE_WINDOW_MS)),
          notInArray(revenueOpportunities.status, [...TERMINAL_STATUSES]),
        ),
      )
      .returning({ id: revenueOpportunities.id, evidenceProductId: revenueOpportunities.evidenceProductId });
    if (expired.length > 0) {
      await tx
        .update(recommendations)
        .set({ state: 'dismissed', closedAt: now, closedReason: WEBSITE_EXPIRED_REASON, updatedAt: now })
        .where(
          and(
            eq(recommendations.workspaceId, workspaceId),
            inArray(recommendations.sourceOpportunityId, expired.map((row) => row.id)),
            eq(recommendations.state, 'active'),
          ),
        );
    }

    // Recreation rule: per product, only evidence after the latest closure of a website opportunity counts.
    const closedAtByProduct = new Map<string, Date>();
    const closures = [
      ...websiteRows.filter((r) => isTerminal(r.status)).map((r) => ({ productId: r.evidenceProductId, at: r.closedAt ?? r.updatedAt })),
      ...expired.map((r) => ({ productId: r.evidenceProductId, at: now })),
    ];
    for (const { productId, at } of closures) {
      if (productId && at > (closedAtByProduct.get(productId) ?? new Date(0))) closedAtByProduct.set(productId, at);
    }

    let best: { intent: WebsiteProductIntent; qualification: WebsiteQualification } | null = null;
    for (const intent of intents) {
      const qualification = qualifyWebsiteIntent(intent, now, closedAtByProduct.get(intent.productId) ?? null);
      if (qualification && (!best || strongerQualification(qualification, best.qualification) < 0)) best = { intent, qualification };
    }
    if (!best) return null;

    const { intent, qualification } = best;
    const price = await this.getLowestVariantPrice(workspaceId, intent.productId);
    return {
      type: 'cross_sell',
      confidence: qualification.kind === 'cart' ? WEBSITE_CONFIDENCE_CART : WEBSITE_CONFIDENCE_VIEWS,
      estimatedRevenue: price !== null ? (price * qualification.quantity).toFixed(2) : null,
      reason:
        qualification.kind === 'cart'
          ? `Customer added "${intent.title}" to their cart (quantity ${qualification.quantity}) on the website and has not purchased it.`
          : `Customer viewed "${intent.title}" ${qualification.viewCount} times across ${qualification.sessionCount} website sessions in the last 7 days and has not purchased it.`,
      recommendedAction: `Recommend "${intent.title}" to the customer.`,
      evidenceProductId: intent.productId,
      evidenceAt: qualification.evidenceAt,
    };
  }

  private async getOpenTypes(workspaceId: string, canonicalCustomerId: string, executor: NodePgDatabase): Promise<Set<OpportunityType>> {
    const rows = await executor
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

  /**
   * cross_sell/bundle (approved Phase 7 heuristic). At most one candidate:
   * the single highest-ratio qualifying (owned, other) product pair,
   * checked against the bundle threshold first — a pair meeting bundle's
   * bar never falls through to cross_sell (approved scope: "surface as
   * Bundle only"). Sequential awaits throughout (not Promise.all) —
   * deliberately: this runs at most a handful of times per detect() call,
   * and a strictly linear query order is far easier to reason about/test
   * than shaving a few ms of parallelism.
   */
  private async detectAffinityOpportunity(workspaceId: string, canonicalCustomerId: string): Promise<OpportunityCandidate | null> {
    const totalOrders = await this.getWorkspaceOrderCount(workspaceId);
    if (totalOrders < MIN_WORKSPACE_ORDERS_FOR_AFFINITY) {
      return null;
    }

    const ownedProductIds = await this.getPurchasedProductIds(workspaceId, canonicalCustomerId);
    if (ownedProductIds.length === 0) {
      return null;
    }

    const affinityRows = await this.getProductAffinity(workspaceId, ownedProductIds);
    if (affinityRows.length === 0) {
      return null;
    }

    const orderCountByProduct = new Map((await this.getOwnedProductOrderCounts(workspaceId, ownedProductIds)).map((row) => [row.productId, Number(row.orderCount)]));

    let bestBundle: { ownedProductId: string; otherProductId: string; ratio: number } | null = null;
    let bestCrossSell: { ownedProductId: string; otherProductId: string; ratio: number } | null = null;

    for (const row of affinityRows) {
      const orderCountForOwned = orderCountByProduct.get(row.ownedProductId) ?? 0;
      if (orderCountForOwned === 0) {
        continue;
      }
      const coCount = Number(row.coOccurringOrders);
      const ratio = coCount / orderCountForOwned;

      if (coCount >= BUNDLE_MIN_CO_OCCURRING_ORDERS && ratio >= BUNDLE_MIN_RATIO) {
        if (!bestBundle || ratio > bestBundle.ratio) {
          bestBundle = { ownedProductId: row.ownedProductId, otherProductId: row.otherProductId, ratio };
        }
      } else if (coCount >= CROSS_SELL_MIN_CO_OCCURRING_ORDERS && ratio >= CROSS_SELL_MIN_RATIO) {
        if (!bestCrossSell || ratio > bestCrossSell.ratio) {
          bestCrossSell = { ownedProductId: row.ownedProductId, otherProductId: row.otherProductId, ratio };
        }
      }
    }

    if (bestBundle) {
      const ownedPrice = await this.getLowestVariantPrice(workspaceId, bestBundle.ownedProductId);
      const otherPrice = await this.getLowestVariantPrice(workspaceId, bestBundle.otherProductId);
      const combined = ownedPrice !== null && otherPrice !== null ? (ownedPrice + otherPrice).toFixed(2) : null;
      const confidence = Math.min(100, Math.round(bestBundle.ratio * 100));
      return {
        type: 'bundle',
        confidence,
        estimatedRevenue: combined,
        reason: `These two products were purchased together in ${Math.round(bestBundle.ratio * 100)}% of the orders containing the customer's product.`,
        recommendedAction: 'Offer these products together as a bundle.',
      };
    }

    if (bestCrossSell) {
      const otherPrice = await this.getLowestVariantPrice(workspaceId, bestCrossSell.otherProductId);
      const confidence = Math.min(100, Math.round(bestCrossSell.ratio * 100));
      return {
        type: 'cross_sell',
        confidence,
        estimatedRevenue: otherPrice !== null ? otherPrice.toFixed(2) : null,
        reason: `Other customers who bought the same product also bought this one in ${Math.round(bestCrossSell.ratio * 100)}% of matching orders.`,
        recommendedAction: 'Recommend this product to the customer.',
      };
    }

    return null;
  }

  /**
   * upsell (approved Phase 7 heuristic). Evaluates the customer's purchased
   * products most-recently-purchased first, returning the first product
   * with a qualifying higher-priced sibling variant. Sequential — see
   * detectAffinityOpportunity's doc comment for why.
   */
  private async detectUpsell(workspaceId: string, canonicalCustomerId: string): Promise<OpportunityCandidate | null> {
    const purchasedVariants = await this.getPurchasedVariantsByRecency(workspaceId, canonicalCustomerId);
    if (purchasedVariants.length === 0) {
      return null;
    }

    const consideredProductIds = new Set<string>();
    for (const purchased of purchasedVariants) {
      if (consideredProductIds.has(purchased.productId)) {
        continue;
      }
      consideredProductIds.add(purchased.productId);

      const purchasedPrice = parsePrice(purchased.price);
      if (purchasedPrice === null) {
        continue;
      }

      const purchasedVariantIdsForProduct = new Set(
        purchasedVariants.filter((variant) => variant.productId === purchased.productId).map((variant) => variant.variantId),
      );

      const siblings = await this.database.client
        .select({ id: commerceProductVariants.id, price: commerceProductVariants.price, inventoryQuantity: commerceProductVariants.inventoryQuantity })
        .from(commerceProductVariants)
        .where(and(eq(commerceProductVariants.workspaceId, workspaceId), eq(commerceProductVariants.productId, purchased.productId)));

      const higherCandidates = siblings
        .filter((sibling) => !purchasedVariantIdsForProduct.has(sibling.id))
        .filter((sibling) => sibling.inventoryQuantity === null || sibling.inventoryQuantity > 0)
        .map((sibling) => ({ id: sibling.id, price: parsePrice(sibling.price) }))
        .filter((sibling): sibling is { id: string; price: number } => sibling.price !== null && sibling.price > purchasedPrice)
        .sort((a, b) => a.price - b.price);

      if (higherCandidates.length === 0) {
        continue;
      }

      const nearest = higherCandidates[0];
      const confidence = higherCandidates.length === 1 ? UPSELL_CONFIDENCE_SINGLE_CANDIDATE : UPSELL_CONFIDENCE_MULTIPLE_CANDIDATES;
      const revenueDelta = nearest.price - purchasedPrice;

      return {
        type: 'upsell',
        confidence,
        estimatedRevenue: revenueDelta.toFixed(2),
        reason: `Customer purchased a ${purchasedPrice.toFixed(2)} variant; a ${nearest.price.toFixed(2)} variant of the same product is available and unpurchased.`,
        recommendedAction: 'Suggest the higher-tier variant to this customer.',
      };
    }

    return null;
  }

  private async getWorkspaceOrderCount(workspaceId: string): Promise<number> {
    const [row] = await this.database.client
      .select({ count: sql<number>`count(*)` })
      .from(commerceOrders)
      .where(eq(commerceOrders.workspaceId, workspaceId));
    return Number(row?.count ?? 0);
  }

  /** This canonical customer's `commerce_customers` source-row ids (may span multiple providers). */
  private async getSourceCustomerIds(workspaceId: string, canonicalCustomerId: string): Promise<string[]> {
    const rows = await this.database.client
      .select({ id: commerceCustomers.id })
      .from(commerceCustomers)
      .where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.canonicalCustomerId, canonicalCustomerId)));
    return rows.map((row) => row.id);
  }

  /** Distinct product ids this customer has ever purchased, across all their source rows/providers. */
  private async getPurchasedProductIds(workspaceId: string, canonicalCustomerId: string): Promise<string[]> {
    const sourceCustomerIds = await this.getSourceCustomerIds(workspaceId, canonicalCustomerId);
    if (sourceCustomerIds.length === 0) {
      return [];
    }

    const rows = await this.database.client
      .selectDistinct({ productId: commerceProductVariants.productId })
      .from(commerceOrderLineItems)
      .innerJoin(commerceOrders, eq(commerceOrderLineItems.orderId, commerceOrders.id))
      .innerJoin(commerceProductVariants, eq(commerceOrderLineItems.variantId, commerceProductVariants.id))
      .where(and(eq(commerceOrderLineItems.workspaceId, workspaceId), inArray(commerceOrders.customerId, sourceCustomerIds)));

    return rows.map((row) => row.productId);
  }

  /**
   * Workspace-wide same-order co-occurrence: for each of `ownedProductIds`,
   * every OTHER product that shares at least one order with it, and how
   * many distinct orders they share. Self-join over commerce_order_line_items
   * on order_id (approved query shape — shared by cross_sell and bundle).
   */
  private async getProductAffinity(
    workspaceId: string,
    ownedProductIds: string[],
  ): Promise<{ ownedProductId: string; otherProductId: string; coOccurringOrders: number }[]> {
    const otherLineItems = alias(commerceOrderLineItems, 'other_line_items');
    const otherVariants = alias(commerceProductVariants, 'other_variants');

    const rows = await this.database.client
      .select({
        ownedProductId: commerceProductVariants.productId,
        otherProductId: otherVariants.productId,
        coOccurringOrders: sql<number>`count(distinct ${commerceOrderLineItems.orderId})`,
      })
      .from(commerceOrderLineItems)
      .innerJoin(commerceProductVariants, eq(commerceOrderLineItems.variantId, commerceProductVariants.id))
      .innerJoin(
        otherLineItems,
        and(eq(otherLineItems.orderId, commerceOrderLineItems.orderId), sql`${otherLineItems.id} != ${commerceOrderLineItems.id}`),
      )
      .innerJoin(otherVariants, eq(otherLineItems.variantId, otherVariants.id))
      .where(
        and(
          eq(commerceOrderLineItems.workspaceId, workspaceId),
          inArray(commerceProductVariants.productId, ownedProductIds),
          notInArray(otherVariants.productId, ownedProductIds),
        ),
      )
      .groupBy(commerceProductVariants.productId, otherVariants.productId);

    return rows as { ownedProductId: string; otherProductId: string; coOccurringOrders: number }[];
  }

  /** Total distinct orders containing each of `ownedProductIds` — the ratio denominator. */
  private async getOwnedProductOrderCounts(workspaceId: string, ownedProductIds: string[]): Promise<{ productId: string; orderCount: number }[]> {
    const rows = await this.database.client
      .select({
        productId: commerceProductVariants.productId,
        orderCount: sql<number>`count(distinct ${commerceOrderLineItems.orderId})`,
      })
      .from(commerceOrderLineItems)
      .innerJoin(commerceProductVariants, eq(commerceOrderLineItems.variantId, commerceProductVariants.id))
      .where(and(eq(commerceOrderLineItems.workspaceId, workspaceId), inArray(commerceProductVariants.productId, ownedProductIds)))
      .groupBy(commerceProductVariants.productId);

    return rows as { productId: string; orderCount: number }[];
  }

  private async getLowestVariantPrice(workspaceId: string, productId: string): Promise<number | null> {
    const rows = await this.database.client
      .select({ price: commerceProductVariants.price })
      .from(commerceProductVariants)
      .where(and(eq(commerceProductVariants.workspaceId, workspaceId), eq(commerceProductVariants.productId, productId)));

    const prices = rows.map((row) => parsePrice(row.price)).filter((price): price is number => price !== null);
    return prices.length > 0 ? Math.min(...prices) : null;
  }

  /**
   * This customer's purchased variants, deduped by variant id and ordered
   * newest-purchase-first (by the owning order's own timestamp, same
   * recency convention as CustomerIntelligenceService.getActivity —
   * `orderPlacedAt()`, when the order was placed at the source).
   */
  private async getPurchasedVariantsByRecency(
    workspaceId: string,
    canonicalCustomerId: string,
  ): Promise<{ variantId: string; productId: string; price: string | null; purchasedAt: Date }[]> {
    const sourceCustomerIds = await this.getSourceCustomerIds(workspaceId, canonicalCustomerId);
    if (sourceCustomerIds.length === 0) {
      return [];
    }

    const rows = await this.database.client
      .select({
        variantId: commerceProductVariants.id,
        productId: commerceProductVariants.productId,
        price: commerceProductVariants.price,
        purchasedAt: orderPlacedAt(),
      })
      .from(commerceOrderLineItems)
      .innerJoin(commerceOrders, eq(commerceOrderLineItems.orderId, commerceOrders.id))
      .innerJoin(commerceProductVariants, eq(commerceOrderLineItems.variantId, commerceProductVariants.id))
      .where(and(eq(commerceOrderLineItems.workspaceId, workspaceId), inArray(commerceOrders.customerId, sourceCustomerIds)));

    const byVariant = new Map<string, { variantId: string; productId: string; price: string | null; purchasedAt: Date }>();
    for (const row of rows) {
      const { purchasedAt } = row;
      const existing = byVariant.get(row.variantId);
      if (!existing || purchasedAt > existing.purchasedAt) {
        byVariant.set(row.variantId, { variantId: row.variantId, productId: row.productId, price: row.price, purchasedAt });
      }
    }

    return [...byVariant.values()].sort((a, b) => b.purchasedAt.getTime() - a.purchasedAt.getTime());
  }
}

/** Same convention as commerce_orders.totalPrice/commerce_product_variants.price — raw provider text, no currency unit tracked. */
function parsePrice(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
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

  // recentOrders is newest-first by source placement time (orderPlacedAt) — never BRAYN's
  // import time, which a batch import makes identical for every order (~0-day gaps).
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
/** Bounded up/down step already used for the revenue factor below — reused for health so neither factor outweighs the other. */
const PRIORITY_BOOST = 1.2;
const PRIORITY_DAMPEN = 0.8;

/**
 * Customer Risk & Engagement State factor (doc10 priority formula; Milestone #5 Release 1 direction, user decision Oct 31, 2026):
 * Critical/At Risk favor win-back, Critical dampens pure upsell, Healthy favors upsell/cross-sell and dampens win-back.
 * Types and categories not listed (reorder, VIP, bundle; Neutral; no health state) get no adjustment.
 */
const HEALTH_PRIORITY_ADJUSTMENTS: Partial<Record<HealthCategory, Partial<Record<OpportunityType, number>>>> = {
  Critical: { win_back: PRIORITY_BOOST, upsell: PRIORITY_DAMPEN },
  'At Risk': { win_back: PRIORITY_BOOST },
  Healthy: { upsell: PRIORITY_BOOST, cross_sell: PRIORITY_BOOST, win_back: PRIORITY_DAMPEN },
};

export function computePriority(
  confidence: number,
  estimatedRevenue: string | null,
  avgOrderValue: number | null,
  type: OpportunityType,
  healthCategory: string | null,
): OpportunityPriority {
  let score = confidence;

  const revenue = estimatedRevenue ? Number(estimatedRevenue) : null;
  if (revenue !== null && avgOrderValue !== null && avgOrderValue > 0) {
    const ratio = revenue / avgOrderValue;
    score *= ratio >= 1.5 ? PRIORITY_BOOST : ratio < 0.5 ? PRIORITY_DAMPEN : 1;
  }

  score *= HEALTH_PRIORITY_ADJUSTMENTS[healthCategory as HealthCategory]?.[type] ?? 1;

  if (score >= 90) return 'critical';
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}
