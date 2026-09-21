import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { customerHealthStates } from '../../database/schema/customer-health-states';
import { customerHealthStateHistory } from '../../database/schema/customer-health-state-history';
import { DatabaseService } from '../../database/database.service';
import { NotFoundError } from '../../common/errors/app-error';
import { createEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { CustomerIntelligenceService, type BehaviouralContext } from '../customer-intelligence/customer-intelligence.service';

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
 * Only 65% of the spec'd weight (recency + frequency + website engagement)
 * is available, so `score`/`healthCategory`/`trend` stay null rather than
 * emit a number computed from part of the locked formula — this was an
 * explicit choice, not a default (see this part's completion report).
 * `signals` and `reasonCodes` are always populated from what's actually
 * available, so the withheld score is still explainable (doc10's own
 * requirement).
 *
 * Recalculation is on-demand only (`recalculate()`) — doc10's "event-
 * driven recalculation" (wiring this into every order/customer-change
 * touchpoint) and "daily recalculation" (a scheduler) are real
 * additional scope, deliberately deferred rather than built speculatively
 * (doc18 — "Do not introduce... Schedulers... speculatively"). That
 * deferral is about what *triggers* a recalculation — separately, every
 * completed recalculation now emits `customer_health.recalculated` (doc10
 * — "Health changes should publish events for dependent intelligence and
 * automation"), so downstream consumers (Business Action Automation) have
 * a real trigger once one is built. No handler exists yet.
 */
@Injectable()
export class CustomerHealthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly customerIntelligenceService: CustomerIntelligenceService,
    private readonly eventBus: EventBus,
  ) {}

  async recalculate(workspaceId: string, canonicalCustomerId: string): Promise<CustomerHealthState> {
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

    const reasonCodes = [
      recency.reasonCode,
      frequency.reasonCode,
      websiteEngagement.reasonCode,
      'Overall score withheld — only 65% of doc10\'s signal weight is available (missing WhatsApp/customer-experience signals; email pending a product decision).',
    ];

    const now = new Date();
    const state: CustomerHealthState = {
      workspaceId,
      canonicalCustomerId,
      score: null,
      healthCategory: null,
      signals,
      reasonCodes,
      trend: null,
      lastCalculatedAt: now,
    };

    await this.database.client
      .insert(customerHealthStates)
      .values(state)
      .onConflictDoUpdate({
        target: [customerHealthStates.workspaceId, customerHealthStates.canonicalCustomerId],
        set: { score: state.score, healthCategory: state.healthCategory, signals, reasonCodes, trend: state.trend, lastCalculatedAt: now, updatedAt: now },
      });
    await this.database.client.insert(customerHealthStateHistory).values({ ...state, calculatedAt: now });

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
    const [row] = await this.database.client
      .select()
      .from(customerHealthStates)
      .where(and(eq(customerHealthStates.workspaceId, workspaceId), eq(customerHealthStates.canonicalCustomerId, canonicalCustomerId)))
      .limit(1);

    if (!row) {
      throw new NotFoundError('No health state has been calculated yet for this customer.');
    }

    return row as unknown as CustomerHealthState;
  }
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
  const recencyScore = Math.max(0, Math.round(100 - (daysSinceLastActivity / WEBSITE_RECENCY_DECAY_DAYS) * 100));
  const frequencyScore = Math.min(100, Math.round((eventsCount / WEBSITE_FREQUENCY_TARGET_EVENTS) * 100));
  const score = Math.round(recencyScore * WEBSITE_RECENCY_SUBWEIGHT + frequencyScore * WEBSITE_FREQUENCY_SUBWEIGHT);

  return {
    value: eventsCount,
    score,
    reasonCode: `${eventsCount} website event(s) recorded, most recent ${daysSinceLastActivity} day(s) ago — website engagement score ${score}/100.`,
  };
}
