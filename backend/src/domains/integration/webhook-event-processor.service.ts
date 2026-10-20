import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, asc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { withRetry } from '../../common/async/retry';
import { createEvent, type DomainEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { scrubSensitive } from '../../common/logging/scrub-sensitive';
import { CustomerService } from '../commerce/customer.service';
import { ProductService } from '../commerce/product.service';
import { OrderService } from '../commerce/order.service';
import { CollectionService } from '../commerce/collection.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import { isWebhookResourceEvent, type WebhookResourceEvent } from './provider-adapter.interface';
import type { IntegrationProvider } from './dto/connect-integration.schema';

/** Claims (processing attempts) before a delivery is dead-lettered. */
export const WEBHOOK_MAX_ATTEMPTS = 5;
/** How long one claim is held; far above one record's processing time. Past it, the claim counts as abandoned. */
export const WEBHOOK_LEASE_MS = 2 * 60_000;
/** Backoff before attempt n+1 is `RETRY_BASE_DELAY_MS * 2^(n-1)`: 30s, 1m, 2m, 4m. */
const RETRY_BASE_DELAY_MS = 30_000;
/** In-process retries within one attempt, for sub-second transient blips (the existing `withRetry` convention). */
const IN_ATTEMPT_RETRIES = 3;
const POLL_INTERVAL_MS = 30_000;
/** Bounds one poll tick, so a large backlog can't monopolize a tick. */
const MAX_EVENTS_PER_TICK = 50;

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The stored payload is the normalized record round-tripped through jsonb,
 * so its Date fields (`sourceUpdatedAt`, `sourceCreatedAt`, `processedAt`,
 * … — every normalized timestamp field ends in `At`) come back as ISO
 * strings. Restores them so the commerce upserts get the Dates they expect.
 *
 * ponytail: keyed on the `…At` naming convention of the Normalized* types;
 * replace with a per-resource schema parse if a non-timestamp `…At` field
 * ever appears.
 */
function reviveDates(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    return key.endsWith('At') && ISO_TIMESTAMP.test(value) ? new Date(value) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => reviveDates(item));
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reviveDates(v, k)]));
  }
  return value;
}

/** Wake-up signal only — the row it names is the actual work item. */
export interface WebhookReceivedPayload {
  webhookEventId: string;
}

/** Doc10 — "Order Placed" is a significant Customer Health event. Emitted only for a webhook-delivered order that was genuinely just inserted (see OrderService.upsertMany's doc comment) — never for a bulk import/sync/reconciliation pass, which represents pre-existing order history, not a new order being placed. */
export interface OrderCreatedPayload {
  canonicalCustomerId: string;
}


export interface ClaimedWebhookEvent {
  id: string;
  workspaceId: string;
  integrationId: string;
  provider: IntegrationProvider;
  payload: unknown;
  claimToken: string;
  /** This claim's attempt number (1-based). */
  attempt: number;
}

/**
 * Applies webhook-delivered records to commerce data (doc 06 — Integration
 * produces normalized data, the owning domain stores it), driven by the
 * durable `integration_webhook_events` rows (see that schema's lifecycle
 * comment), never by in-memory delivery alone:
 *
 * - `integration.webhook.received` (emitted by WebhookIngestService after
 *   the row is committed) is only a wake-up: it claims that one row now.
 * - `startPolling()` (called once from main.ts — never in tests) sweeps
 *   every due `pending` row and every `processing` row whose lease
 *   expired, so a lost wake-up, a crashed worker, or a restart only
 *   delays processing, never loses it.
 *
 * Claiming is one UPDATE over a `FOR UPDATE SKIP LOCKED` subselect that
 * stamps a fresh `claimToken`: concurrent workers (other instances, or a
 * wake-up racing a poll) never claim the same row at once, and every
 * outcome write is conditioned on that token (see `finish()`).
 *
 * Doc 21 "Processing Failure" / doc 07 "Job Lifecycle": a failed attempt
 * goes back to `pending` with exponential backoff; after
 * WEBHOOK_MAX_ATTEMPTS it moves to `dead_letter` (replayable via
 * WebhookIngestService.replay) — never retried forever, never dropped.
 *
 * The `order` case additionally emits `order.created` (see
 * OrderCreatedPayload's doc comment) for a genuinely new order —
 * `CustomerHealthService` is its consumer. A retried attempt re-upserts an
 * already-stored order, which yields no new-order id, so it emits nothing new.
 */
@Injectable()
export class WebhookEventProcessorService implements OnModuleDestroy {
  private pollTimer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly customerService: CustomerService,
    private readonly productService: ProductService,
    private readonly orderService: OrderService,
    private readonly collectionService: CollectionService,
    private readonly identityResolutionService: IdentityResolutionService,
    private readonly eventBus: EventBus,
    private readonly logger: StructuredLoggerService,
  ) {}

  @OnEvent('integration.webhook.received')
  async handleWebhookReceived(event: DomainEvent<WebhookReceivedPayload>): Promise<void> {
    try {
      await this.processEvent(event.payload.webhookEventId);
    } catch (error) {
      // The row is still pending (or its claim will expire) — the poller picks it up.
      this.logger.event('error', 'Webhook wake-up processing threw; left for the recovery poller', 'WebhookEventProcessorService', {
        webhookEventId: event.payload.webhookEventId,
        integrationId: event.entityId,
        workspaceId: event.workspaceId,
        error: scrubSensitive(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  /** Claims and processes one specific row, if it's currently claimable. Returns whether this call processed it. */
  async processEvent(webhookEventId: string): Promise<boolean> {
    const [claimed] = await this.claim({ webhookEventId });
    if (!claimed) return false;
    await this.run(claimed);
    return true;
  }

  /** Claims and processes due/abandoned rows one at a time until none remain (bounded per call). Returns how many were processed. */
  async processDue(maxEvents = MAX_EVENTS_PER_TICK): Promise<number> {
    let processed = 0;
    while (processed < maxEvents) {
      const [claimed] = await this.claim();
      if (!claimed) break;
      await this.run(claimed);
      processed++;
    }
    return processed;
  }

  startPolling(intervalMs = POLL_INTERVAL_MS): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => void this.tick(), intervalMs);
    this.pollTimer.unref();
    void this.tick(); // recover any backlog left by the previous process right away
  }

  onModuleDestroy(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  /**
   * Atomically claims up to `limit` claimable rows: `pending` and due, or
   * `processing` with an expired lease. Each claim gets a fresh token, a
   * new lease, and an incremented attempt count.
   */
  async claim(options: { webhookEventId?: string; limit?: number } = {}): Promise<ClaimedWebhookEvent[]> {
    const t = integrationWebhookEvents;
    const claimable = this.database.client
      .select({ id: t.id })
      .from(t)
      .where(
        and(
          options.webhookEventId ? eq(t.id, options.webhookEventId) : undefined,
          or(
            and(eq(t.status, 'pending'), lte(t.nextAttemptAt, sql`now()`)),
            and(eq(t.status, 'processing'), lt(t.lockedUntil, sql`now()`)),
          ),
        ),
      )
      .orderBy(asc(t.nextAttemptAt))
      .limit(options.limit ?? 1)
      .for('update', { skipLocked: true });

    const rows = await this.database.client
      .update(t)
      .set({
        status: 'processing',
        claimToken: sql`gen_random_uuid()`,
        lockedUntil: sql`now() + ${WEBHOOK_LEASE_MS} * interval '1 millisecond'`,
        retryCount: sql`${t.retryCount} + 1`,
      })
      .where(inArray(t.id, claimable))
      .returning({
        id: t.id,
        workspaceId: t.workspaceId,
        integrationId: t.integrationId,
        payload: t.payload,
        claimToken: t.claimToken,
        attempt: t.retryCount,
        provider: sql<IntegrationProvider>`(select ${integrations.provider} from ${integrations} where ${integrations.id} = ${t.integrationId})`,
      });

    return rows as ClaimedWebhookEvent[];
  }

  /** Marks a claimed row processed. Returns false (and writes nothing) if the claim is no longer this worker's. */
  async complete(claimed: Pick<ClaimedWebhookEvent, 'id' | 'claimToken'>): Promise<boolean> {
    return this.finish(claimed, { status: 'processed', processedAt: new Date(), error: null });
  }

  private async run(claimed: ClaimedWebhookEvent): Promise<void> {
    if (claimed.attempt > WEBHOOK_MAX_ATTEMPTS) {
      // Only reachable via repeated lease expiry: every attempt crashed or hung before reporting.
      await this.fail(claimed, 'Processing was abandoned (worker crash or timeout) on every attempt.');
      return;
    }
    const payload = reviveDates(claimed.payload);
    if (!isWebhookResourceEvent(payload)) {
      await this.fail(claimed, 'Stored payload is not a recognized webhook resource event.', { permanent: true });
      return;
    }

    try {
      await withRetry(() => this.applyResource(claimed.workspaceId, claimed.integrationId, claimed.provider, payload), {
        maxAttempts: IN_ATTEMPT_RETRIES,
      });
    } catch (error) {
      await this.fail(claimed, error instanceof Error ? error.message : 'Unknown error');
      return;
    }

    if (!(await this.complete(claimed))) {
      this.logger.event('warn', 'Webhook processed by a worker whose claim had already been taken over; outcome not recorded', 'WebhookEventProcessorService', this.logContext(claimed));
    }
  }

  /** Reschedules with backoff, or dead-letters once attempts are exhausted (or immediately for a permanent failure). */
  private async fail(claimed: ClaimedWebhookEvent, rawMessage: string, options: { permanent?: boolean } = {}): Promise<void> {
    // Persisted alongside the row (doc 21 "Processing Failure") — scrubbed like any other log destination.
    const error = scrubSensitive(rawMessage);
    const exhausted = options.permanent || claimed.attempt >= WEBHOOK_MAX_ATTEMPTS;
    const recorded = exhausted
      ? await this.finish(claimed, { status: 'dead_letter', error })
      : await this.finish(claimed, {
          status: 'pending',
          error,
          nextAttemptAt: sql`now() + ${RETRY_BASE_DELAY_MS * 2 ** (claimed.attempt - 1)} * interval '1 millisecond'`,
        });

    this.logger.event(
      'error',
      exhausted ? 'Webhook processing failed permanently — moved to dead_letter' : 'Webhook processing attempt failed — rescheduled with backoff',
      'WebhookEventProcessorService',
      { ...this.logContext(claimed), maxAttempts: WEBHOOK_MAX_ATTEMPTS, error, outcomeRecorded: recorded },
    );
  }

  /** The fencing point: every outcome write requires the row to still hold this worker's claim token. */
  private async finish(
    claimed: Pick<ClaimedWebhookEvent, 'id' | 'claimToken'>,
    set: PgUpdateSetSource<typeof integrationWebhookEvents>,
  ): Promise<boolean> {
    const t = integrationWebhookEvents;
    const rows = await this.database.client
      .update(t)
      .set({ ...set, claimToken: null, lockedUntil: null })
      .where(and(eq(t.id, claimed.id), eq(t.status, 'processing'), eq(t.claimToken, claimed.claimToken)))
      .returning({ id: t.id });
    return rows.length > 0;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.processDue();
    } catch (error) {
      this.logger.event('error', 'Webhook recovery poll failed', 'WebhookEventProcessorService', {
        error: scrubSensitive(error instanceof Error ? error.message : String(error)),
      });
    } finally {
      this.ticking = false;
    }
  }

  private logContext(claimed: ClaimedWebhookEvent) {
    return {
      webhookEventId: claimed.id,
      integrationId: claimed.integrationId,
      workspaceId: claimed.workspaceId,
      attempt: claimed.attempt,
    };
  }

  private async applyResource(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    payload: WebhookResourceEvent,
  ): Promise<void> {
    switch (payload.resource) {
      case 'customer':
        await this.customerService.upsertMany(workspaceId, integrationId, provider, [payload.data]);
        await this.identityResolutionService.resolveMany(workspaceId, provider, [payload.data.externalId]);
        break;
      case 'product':
        await this.productService.upsertMany(workspaceId, integrationId, provider, [payload.data]);
        break;
      case 'order': {
        const { newOrderCanonicalCustomerIds } = await this.orderService.upsertMany(workspaceId, integrationId, provider, [payload.data]);
        for (const canonicalCustomerId of newOrderCanonicalCustomerIds) {
          this.eventBus.emit(
            createEvent<OrderCreatedPayload>({ type: 'order.created', workspaceId, payload: { canonicalCustomerId } }),
          );
        }
        break;
      }
      case 'fulfillment':
        await this.orderService.upsertFulfillments(workspaceId, integrationId, provider, [payload.data]);
        break;
      case 'collection':
        await this.collectionService.upsertMany(workspaceId, integrationId, provider, [payload.data]);
        break;
    }
  }
}
