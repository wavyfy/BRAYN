import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, eq } from 'drizzle-orm';
import { customerHealthStates } from '../../database/schema/customer-health-states';
import { customerHealthStateHistory } from '../../database/schema/customer-health-state-history';
import { DatabaseService } from '../../database/database.service';
import { NotFoundError } from '../../common/errors/app-error';
import { createEvent, type DomainEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { CustomerIntelligenceService, type BehaviouralContext } from '../customer-intelligence/customer-intelligence.service';
import type { OrderEventPayload } from '../commerce/commerce-events';

/** Doc10 — "Health changes should publish events for dependent intelligence and automation" (doc16 trigger: "Customer Risk & Engagement State changes"). */
export interface CustomerHealthRecalculatedPayload {
  canonicalCustomerId: string;
  score: number | null;
  healthCategory: string | null;
  trend: string | null;
  reasonCodes: string[];
}

/** How many days of no purchase brings the recency signal to 0 — a first-pass heuristic, not a product-specified curve. */
const RECENCY_DECAY_DAYS = 90;
/** Orders in the trailing 90 days that maxes out the frequency signal at 100 — same caveat. */
const FREQUENCY_TARGET_ORDERS = 4;
/**
 * ponytail: website engagement gets one 15% weight slot (doc10), unlike purchase's
 * split recency/frequency (30%/20%). Blended the same way at 60/40 (matching the
 * ratio between doc10's own purchase recency/frequency weights) rather than
 * inventing an unrelated split. Decay/target numbers are first-pass heuristics —
 * same caveat as RECENCY_DECAY_DAYS/FREQUENCY_TARGET_ORDERS above, doc10 defines
 * the weight, not the curve.
 */
const WEBSITE_RECENCY_DECAY_DAYS = 30;
const WEBSITE_FREQUENCY_TARGET_EVENTS = 20;
const WEBSITE_RECENCY_SUBWEIGHT = 0.6;
const WEBSITE_FREQUENCY_SUBWEIGHT = 0.4;

/** Milestone #5 D1 category bands (user decision, Oct 31, 2026) — lower bound inclusive. */
const HEALTH_CATEGORIES = [
  { min: 75, label: 'Healthy' },
  { min: 50, label: 'Neutral' },
  { min: 25, label: 'At Risk' },
  { min: 0, label: 'Critical' },
] as const;
export type HealthCategory = (typeof HEALTH_CATEGORIES)[number]['label'];
/** Score change vs the previous persisted score beyond which the trend is improving/declining (D1). */
const TREND_THRESHOLD = 5;

interface SignalResult {
  value: number | null;
  score: number;
  reasonCode: string;
}

export interface CustomerHealthState {
  workspaceId: string;
  canonicalCustomerId: string;
  score: number | null;
  healthCategory: string | null;
  signals: Record<string, unknown>;
  reasonCodes: string[];
  trend: string | null;
  lastCalculatedAt: Date;
  /** Share of doc10's total signal weight that was available — derived from `signals`, not stored separately. */
  coverage: { availableWeight: number; totalWeight: number };
}

/**
 * Customer Risk & Engagement State (doc10 — "Maintains a continuously
 * updated customer score representing current relationship strength and
 * business risk"). Consumes CustomerIntelligenceService (UCIR) for
 * commerce signals rather than querying commerce tables itself (doc04
 * Rule 2 — "Consume, Don't Duplicate"; doc08's own diagram: UCIR →
 * Customer Intelligence Engines).
 *
 * doc10's Phase 1 weight table (recency 30%, frequency 20%, website 15%,
 * WhatsApp 15%, email 10%, customer experience 10%) needs signals BRAYN
 * doesn't have: WhatsApp engagement needs a domain that doesn't exist yet
 * (Conversation); customer experience has no defined source; email
 * engagement is explicitly flagged in doc10 itself as "PENDING PRODUCT
 * DECISION... do not implement this signal or redistribute its weight
 * without an explicit product decision." Website engagement (Website
 * Behaviour Part 5) is now computed from `CustomerRecord.behaviouralContext`
 * (Part 4) the same way purchase recency/frequency are computed from
 * `commerceContext` — doc10 gives the 15% weight, not the curve, so the
 * decay/target constants above are an explicit first-pass heuristic like
 * `RECENCY_DECAY_DAYS`/`FREQUENCY_TARGET_ORDERS`.
 *
 * Milestone #5 D1 (user decision, Oct 31, 2026): the score is the
 * weighted average of the *available* signals only (their weights rescaled
 * to 100%), so a missing signal is excluded rather than counted as 0;
 * `coverage` reports how much of doc10's weight that was. `score`/
 * `healthCategory` stay null only when the customer has no purchase
 * history and no website activity. `trend` compares against the previous
 * persisted score. `signals` and `reasonCodes` are always populated, so
 * every score is explainable (doc10).
 *
 * Recalculation is triggered two ways: manually via `recalculate()`
 * (merchant-triggered button, Phase 8), and automatically on the commerce
 * domain events that change a customer's commerce history —
 * `order.created`, `order.cancelled`, `refund.processed` (doc10
 * "Event-driven recalculation"; emitted by OrderService for a live,
 * genuinely new state change — see commerce-events.ts). `order.updated`
 * is deliberately not a trigger: it fires on any source edit, and the
 * Phase 1 signals (recency/frequency/website) read nothing an edit
 * changes. The daily run (IntelligenceDailyRunService, Milestone #5 D2)
 * is the third trigger. Every manual/event-driven recalculation emits
 * `customer_health.recalculated` (doc10 — "Health changes should publish
 * events for dependent intelligence and automation"), which
 * `AutomationService` already consumes (Phase 15). The daily run passes
 * `emitOnlyOnChange` so it publishes only when score, category or trend
 * changed — otherwise every enabled health automation would fire for
 * every customer every run (user decision, Nov 1, 2026).
 */
@Injectable()
export class CustomerHealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly customerIntelligenceService: CustomerIntelligenceService,
    private readonly eventBus: EventBus,
    private readonly logger: StructuredLoggerService,
  ) {}

  /**
   * Each of these events is emitted once per state change (a retried/
   * replayed delivery re-applies already-stored state and emits nothing),
   * so no separate dedup check is needed on this side. An event whose
   * customer Identity Resolution hasn't linked (or a guest checkout) has
   * no canonical customer to score and is skipped. Runs in-process off
   * the emitting commerce write (EventBus is synchronous EventEmitter2),
   * so a failure here must never surface as a failure of that write's
   * webhook-delivery retry/dead-letter handling — same fire-and-forget
   * boundary `AutomationService`'s event handlers already rely on.
   */
  @OnEvent('order.created')
  @OnEvent('order.cancelled')
  @OnEvent('refund.processed')
  async handleCommerceEvent(event: DomainEvent<OrderEventPayload>): Promise<void> {
    const { canonicalCustomerId } = event.payload;
    if (!event.workspaceId || !canonicalCustomerId) return;

    try {
      await this.recalculate(event.workspaceId, canonicalCustomerId);
    } catch (error) {
      this.logger.event('error', `Health recalculation on ${event.type} threw unexpectedly`, 'CustomerHealthService', {
        canonicalCustomerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async recalculate(
    workspaceId: string,
    canonicalCustomerId: string,
    options: { emitOnlyOnChange?: boolean } = {},
  ): Promise<CustomerHealthState> {
    const customer = await this.customerIntelligenceService.getCustomer(workspaceId, canonicalCustomerId);
    const recency = computeRecencySignal(customer.commerceContext.lastOrderAt);
    const frequency = computeFrequencySignal(customer.commerceContext.ordersLast90Days);
    const websiteEngagement = computeWebsiteEngagementSignal(customer.behaviouralContext);

    const signals = {
      purchaseRecency: { weight: 30, available: true, ...recency },
      purchaseFrequency: { weight: 20, available: true, ...frequency },
      websiteEngagement: { weight: 15, available: true, ...websiteEngagement },
      whatsappEngagement: { weight: 15, available: false, reason: 'Conversation domain not built yet.' },
      emailEngagement: {
        weight: 10,
        available: false,
        reason: 'Pending product decision (doc10) — do not implement without explicit sign-off.',
      },
      customerExperience: { weight: 10, available: false, reason: 'No source defined yet.' },
    };

    const coverage = computeCoverage(signals);
    const hasActivity = customer.commerceContext.ordersCount > 0 || customer.behaviouralContext.eventsCount > 0;
    const score = hasActivity ? computeScore(signals) : null;
    const previous = await this.findCurrent(workspaceId, canonicalCustomerId);

    const reasonCodes = [
      recency.reasonCode,
      frequency.reasonCode,
      websiteEngagement.reasonCode,
      score === null
        ? 'No purchase history or website activity — overall score withheld.'
        : `Overall score ${score}/100 from the available ${coverage.availableWeight}% of doc10's signal weight, rescaled to 100% (WhatsApp/customer-experience unavailable; email pending a product decision).`,
    ];

    const now = new Date();
    const row = {
      workspaceId,
      canonicalCustomerId,
      score,
      healthCategory: score === null ? null : categorize(score),
      signals,
      reasonCodes,
      trend: computeTrend(score, previous?.score ?? null),
      lastCalculatedAt: now,
    };
    const state: CustomerHealthState = { ...row, coverage };

    await this.database.client
      .insert(customerHealthStates)
      .values(row)
      .onConflictDoUpdate({
        target: [customerHealthStates.workspaceId, customerHealthStates.canonicalCustomerId],
        set: { score: state.score, healthCategory: state.healthCategory, signals, reasonCodes, trend: state.trend, lastCalculatedAt: now, updatedAt: now },
      });
    await this.database.client.insert(customerHealthStateHistory).values({ ...row, calculatedAt: now });

    const changed =
      !previous || previous.score !== state.score || previous.healthCategory !== state.healthCategory || previous.trend !== state.trend;
    if (options.emitOnlyOnChange && !changed) return state;

    this.eventBus.emit(
      createEvent<CustomerHealthRecalculatedPayload>({
        type: 'customer_health.recalculated',
        workspaceId,
        entityId: canonicalCustomerId,
        payload: { canonicalCustomerId, score: state.score, healthCategory: state.healthCategory, trend: state.trend, reasonCodes: state.reasonCodes },
      }),
    );

    return state;
  }

  async getCurrent(workspaceId: string, canonicalCustomerId: string): Promise<CustomerHealthState> {
    const state = await this.findCurrent(workspaceId, canonicalCustomerId);
    if (!state) {
      throw new NotFoundError('No health state has been calculated yet for this customer.');
    }
    return state;
  }

  /** The persisted state, or null when none has been calculated yet. */
  async findCurrent(workspaceId: string, canonicalCustomerId: string): Promise<CustomerHealthState | null> {
    const [row] = await this.database.client
      .select()
      .from(customerHealthStates)
      .where(and(eq(customerHealthStates.workspaceId, workspaceId), eq(customerHealthStates.canonicalCustomerId, canonicalCustomerId)))
      .limit(1);

    if (!row) return null;
    return { ...(row as unknown as CustomerHealthState), coverage: computeCoverage(row.signals as Record<string, unknown>) };
  }
}

type WeightedSignal = { weight: number; available: boolean; score?: number };

function computeCoverage(signals: Record<string, unknown>): { availableWeight: number; totalWeight: number } {
  const all = Object.values(signals) as WeightedSignal[];
  const sum = (list: WeightedSignal[]) => list.reduce((total, signal) => total + signal.weight, 0);
  return { availableWeight: sum(all.filter((signal) => signal.available)), totalWeight: sum(all) };
}

/** Weighted average over the available signals only — their weights rescaled to 100% (D1). */
function computeScore(signals: Record<string, unknown>): number | null {
  const available = (Object.values(signals) as WeightedSignal[]).filter((signal) => signal.available);
  const weight = available.reduce((total, signal) => total + signal.weight, 0);
  if (weight === 0) return null;
  return Math.round(available.reduce((total, signal) => total + (signal.score ?? 0) * signal.weight, 0) / weight);
}

export function categorize(score: number): HealthCategory {
  return HEALTH_CATEGORIES.find((category) => score >= category.min)!.label;
}

export function computeTrend(score: number | null, previousScore: number | null): 'improving' | 'declining' | 'stable' | 'unknown' {
  if (score === null || previousScore === null) return 'unknown';
  const delta = score - previousScore;
  if (delta > TREND_THRESHOLD) return 'improving';
  if (delta < -TREND_THRESHOLD) return 'declining';
  return 'stable';
}

function computeRecencySignal(lastOrderAt: Date | null): SignalResult {
  if (!lastOrderAt) {
    return { value: null, score: 0, reasonCode: 'No orders on record — recency score 0/100.' };
  }

  const daysSince = Math.floor((Date.now() - lastOrderAt.getTime()) / (24 * 60 * 60 * 1000));
  const score = Math.max(0, Math.round(100 - (daysSince / RECENCY_DECAY_DAYS) * 100));
  return { value: daysSince, score, reasonCode: `Last order ${daysSince} day(s) ago — recency score ${score}/100.` };
}

function computeFrequencySignal(ordersLast90Days: number): SignalResult {
  const score = Math.min(100, Math.round((ordersLast90Days / FREQUENCY_TARGET_ORDERS) * 100));
  return { value: ordersLast90Days, score, reasonCode: `${ordersLast90Days} order(s) in last 90 days — frequency score ${score}/100.` };
}

/**
 * `behaviouralContext` (Part 4) only exposes a linked visitor's activity —
 * an unlinked/never-tracked customer looks identical to a linked one with
 * zero events (`eventsCount: 0, lastActivityAt: null`), same "never a
 * guess" boundary as the rest of that field. Both correctly score 0 here.
 */
function computeWebsiteEngagementSignal(behaviouralContext: BehaviouralContext): SignalResult {
  const { eventsCount, lastActivityAt } = behaviouralContext;
  if (eventsCount === 0 || !lastActivityAt) {
    return { value: 0, score: 0, reasonCode: 'No website activity recorded — website engagement score 0/100.' };
  }

  const daysSinceLastActivity = Math.floor((Date.now() - lastActivityAt.getTime()) / (24 * 60 * 60 * 1000));
  // Clamped above too: client clock skew (accepted within a few minutes) can put lastActivityAt slightly in the future.
  const recencyScore = Math.min(100, Math.max(0, Math.round(100 - (daysSinceLastActivity / WEBSITE_RECENCY_DECAY_DAYS) * 100)));
  const frequencyScore = Math.min(100, Math.round((eventsCount / WEBSITE_FREQUENCY_TARGET_EVENTS) * 100));
  const score = Math.round(recencyScore * WEBSITE_RECENCY_SUBWEIGHT + frequencyScore * WEBSITE_FREQUENCY_SUBWEIGHT);

  return {
    value: eventsCount,
    score,
    reasonCode: `${eventsCount} website event(s) recorded, most recent ${daysSinceLastActivity} day(s) ago — website engagement score ${score}/100.`,
  };
}
