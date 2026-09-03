import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { customerHealthStates } from '../../database/schema/customer-health-states';
import { customerHealthStateHistory } from '../../database/schema/customer-health-state-history';
import { DatabaseService } from '../../database/database.service';
import { NotFoundError } from '../../common/errors/app-error';
import { createEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';

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
 * doesn't have: website/WhatsApp engagement need domains that don't
 * exist yet (Website Behaviour, Conversation); customer experience has
 * no defined source; email engagement is explicitly flagged in doc10
 * itself as "PENDING PRODUCT DECISION... do not implement this signal or
 * redistribute its weight without an explicit product decision."
 *
 * Only 50% of the spec'd weight (recency + frequency) is available, so
 * `score`/`healthCategory`/`trend` stay null rather than emit a number
 * computed from half the locked formula — this was an explicit choice,
 * not a default (see this part's completion report). `signals` and
 * `reasonCodes` are always populated from what's actually available, so
 * the withheld score is still explainable (doc10's own requirement).
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

    const signals = {
      purchaseRecency: { weight: 30, available: true, ...recency },
      purchaseFrequency: { weight: 20, available: true, ...frequency },
      websiteEngagement: { weight: 15, available: false, reason: 'Website Behaviour domain not built yet.' },
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
      'Overall score withheld — only 50% of doc10\'s signal weight is available (missing website/WhatsApp/customer-experience signals; email pending a product decision).',
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
