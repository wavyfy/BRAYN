import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createEvent, type DomainEvent } from '../../common/events/domain-event';
import { EventBus } from '../../common/events/event-bus.service';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { commerceOrderLineItems } from '../../database/schema/commerce-order-line-items';
import { commerceProductVariants } from '../../database/schema/commerce-product-variants';
import { commerceRefunds } from '../../database/schema/commerce-refunds';
import { commerceRefundLineItems } from '../../database/schema/commerce-refund-line-items';
import { commerceFulfillments } from '../../database/schema/commerce-fulfillments';
import { DatabaseService } from '../../database/database.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';
import type { OrderEventPayload, RefundProcessedPayload } from './commerce-events';

export interface NormalizedOrderLineItem {
  externalId: string;
  /** The variant's provider id, or null if the order line has no variant reference (e.g. a custom/removed line). */
  variantExternalId: string | null;
  quantity: number;
  price: string | null;
}

export interface NormalizedRefundLineItem {
  externalId: string;
  /** The refunded order line's provider id, or null if the provider didn't reference one. */
  orderLineItemExternalId: string | null;
  quantity: number;
}

/** A provider's refund record, embedded in its order — see commerce_refunds' doc comment for why there's no separate refund fetch/webhook. */
export interface NormalizedRefund {
  externalId: string;
  note: string | null;
  totalRefunded: string | null;
  processedAt: Date | null;
  lineItems: NormalizedRefundLineItem[];
}

/**
 * A provider's fulfillment record. Embedded in `NormalizedOrder.fulfillments`
 * when it arrives via order import/sync/reconciliation; carries its own
 * `orderExternalId` when it arrives via a standalone fulfillment webhook —
 * see OrderService.upsertFulfillments' doc comment.
 */
export interface NormalizedFulfillment {
  externalId: string;
  status: string | null;
  trackingCompany: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shipmentStatus: string | null;
  sourceUpdatedAt: Date | null;
}

/** A provider's order record, already mapped into BRAYN's shape (doc 06 — Normalization output). */
export interface NormalizedOrder {
  externalId: string;
  /** The customer's provider id, or null for a guest-checkout order. */
  customerExternalId: string | null;
  totalPrice: string | null;
  sourceUpdatedAt: Date | null;
  /** When the order was placed at the source — see commerce_orders.sourceCreatedAt. */
  sourceCreatedAt: Date | null;
  /** When the order was cancelled at the source, null if it isn't — see commerce_orders.sourceCancelledAt. */
  sourceCancelledAt?: Date | null;
  lineItems: NormalizedOrderLineItem[];
  refunds: NormalizedRefund[];
  fulfillments: NormalizedFulfillment[];
}

export interface UpsertOrdersOptions {
  /**
   * Emit commerce domain events (commerce-events.ts) for the state changes
   * this call applies. True for a live change (webhook delivery); false
   * (default) for import/sync/reconciliation, which backfill pre-existing
   * history rather than report something that just happened.
   */
  emitDomainEvents?: boolean;
}

/**
 * Rejects an out-of-order (older) source version on ON CONFLICT so a late
 * delivery never overwrites newer state. Equal versions still write — a
 * retry or a re-import must be able to re-apply the same data. Unknown
 * (null) versions can't be compared and are applied as before.
 */
const NOT_STALE = (table: 'commerce_orders' | 'commerce_fulfillments') =>
  sql.raw(
    `excluded.source_updated_at IS NULL OR ${table}.source_updated_at IS NULL OR excluded.source_updated_at >= ${table}.source_updated_at`,
  );

/** The stored order fields a commerce event payload is built from. */
interface OrderRef {
  id: string;
  externalId: string;
  customerId: string | null;
}

function orderEventPayload(
  provider: IntegrationProvider,
  order: OrderRef,
  canonicalByCustomerId: Map<string, string>,
  sourceOccurredAt: Date | null,
): OrderEventPayload {
  return {
    orderId: order.id,
    orderExternalId: order.externalId,
    provider,
    canonicalCustomerId: order.customerId ? (canonicalByCustomerId.get(order.customerId) ?? null) : null,
    sourceOccurredAt: sourceOccurredAt?.toISOString() ?? null,
  };
}

/** One `refund.processed` per refund row this write inserted (an updated row was already reported by whichever delivery inserted it). */
function refundProcessedEvents(
  workspaceId: string,
  provider: IntegrationProvider,
  refundRows: Array<{ id: string; externalId: string; orderId: string; totalRefunded: string | null; processedAt: Date | null; createdAt: Date; updatedAt: Date }>,
  orderById: Map<string, OrderRef>,
  canonicalByCustomerId: Map<string, string>,
): DomainEvent<RefundProcessedPayload>[] {
  return refundRows
    .filter((refund) => refund.createdAt.getTime() === refund.updatedAt.getTime())
    .map((refund) =>
      createEvent<RefundProcessedPayload>({
        type: 'refund.processed',
        workspaceId,
        entityId: refund.id,
        idempotencyKey: `refund.processed:${refund.id}`,
        payload: {
          ...orderEventPayload(provider, orderById.get(refund.orderId)!, canonicalByCustomerId, refund.processedAt),
          refundId: refund.id,
          refundExternalId: refund.externalId,
          totalRefunded: refund.totalRefunded,
        },
      }),
    );
}

/** Strictly newer source version — what makes an applied write an `order.updated`. A row with no previous version gaining one counts. */
function isNewerVersion(next: Date | null, previous: Date | null): boolean {
  if (!next) return false;
  return !previous || next.getTime() > previous.getTime();
}

/**
 * Owns normalized commerce order/line-item records (doc 22 — Commerce data
 * area). Consumed by Integration's import/webhook pipeline; never the
 * reverse (doc 06 — Integration produces, the owning domain stores).
 *
 * Links each order/line-item to the customer/variant rows this domain
 * already owns (doc 20 — "Required customer/order relationships") on a
 * best-effort basis: a reference to a not-yet-imported customer or
 * variant is stored as null rather than blocking the order itself.
 *
 * Also the producer of the commerce domain events (doc21 Event Producers —
 * "The domain that owns the state/change produces the event"; see
 * commerce-events.ts): each event is derived from the state change this
 * service actually applied, never from a provider webhook topic.
 */
@Injectable()
export class OrderService {
  constructor(
    private readonly database: DatabaseService,
    private readonly eventBus: EventBus,
  ) {}

  /**
   * Writes a batch of orders with their line items, refunds and
   * fulfillments in one transaction — a crash mid-batch leaves nothing
   * half-written, so a retry re-applies the whole order (the durable
   * webhook row is the source of truth; see WebhookEventProcessorService).
   *
   * With `emitDomainEvents`, the order rows are first read `FOR UPDATE` so
   * the previous version/cancellation is known and concurrent deliveries
   * for the same order serialize — a duplicate delivery then sees the
   * already-applied state and emits nothing. Events are emitted only after
   * commit, so a rolled-back write never announces a change.
   */
  async upsertMany(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    orders: NormalizedOrder[],
    options: UpsertOrdersOptions = {},
  ): Promise<{
    ordersWritten: number;
    lineItemsWritten: number;
    refundsWritten: number;
    fulfillmentsWritten: number;
    /**
     * Canonical customer ids for orders that were freshly inserted this
     * call (not an update to a pre-existing order), deduped. Only
     * populated for a customer that Identity Resolution has already
     * linked to a canonical identity (`commerceCustomers.canonicalCustomerId`
     * non-null) — a not-yet-resolved or guest-checkout order yields
     * nothing here, same "don't guess" boundary every other canonical-id
     * consumer in this codebase already follows.
     */
    newOrderCanonicalCustomerIds: string[];
  }> {
    if (orders.length === 0) {
      return { ordersWritten: 0, lineItemsWritten: 0, refundsWritten: 0, fulfillmentsWritten: 0, newOrderCanonicalCustomerIds: [] };
    }

    const { result, events } = await this.database.transaction((db) =>
      this.applyOrders(db, workspaceId, integrationId, provider, orders, options.emitDomainEvents === true),
    );

    for (const event of events) {
      this.eventBus.emit(event);
    }
    return result;
  }

  private async applyOrders(
    db: NodePgDatabase,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    orders: NormalizedOrder[],
    emitDomainEvents: boolean,
  ) {
    const customerIdByExternalId = await this.lookupIds(
      db,
      commerceCustomers,
      workspaceId,
      provider,
      orders.map((order) => order.customerExternalId),
    );

    const previousByExternalId = emitDomainEvents ? await this.lockPreviousState(db, workspaceId, provider, orders) : new Map();

    const orderRows = await db
      .insert(commerceOrders)
      .values(
        orders.map((order) => ({
          workspaceId,
          integrationId,
          provider,
          externalId: order.externalId,
          customerId: order.customerExternalId ? (customerIdByExternalId.get(order.customerExternalId) ?? null) : null,
          totalPrice: order.totalPrice,
          sourceUpdatedAt: order.sourceUpdatedAt,
          sourceCreatedAt: order.sourceCreatedAt,
          sourceCancelledAt: order.sourceCancelledAt ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [commerceOrders.workspaceId, commerceOrders.provider, commerceOrders.externalId],
        set: {
          customerId: sql`excluded.customer_id`,
          totalPrice: sql`excluded.total_price`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          sourceCreatedAt: sql`excluded.source_created_at`,
          sourceCancelledAt: sql`excluded.source_cancelled_at`,
          updatedAt: new Date(),
        },
        // A stale row comes back from RETURNING with nothing — its line items/refunds/fulfillments are skipped with it.
        setWhere: NOT_STALE('commerce_orders'),
      })
      .returning({
        id: commerceOrders.id,
        externalId: commerceOrders.externalId,
        customerId: commerceOrders.customerId,
        sourceUpdatedAt: commerceOrders.sourceUpdatedAt,
        sourceCreatedAt: commerceOrders.sourceCreatedAt,
        sourceCancelledAt: commerceOrders.sourceCancelledAt,
        createdAt: commerceOrders.createdAt,
        updatedAt: commerceOrders.updatedAt,
      });

    const orderIdByExternalId = new Map(orderRows.map((row) => [row.externalId, row.id]));
    /**
     * `createdAt === updatedAt` means this row was inserted, not updated,
     * by this call — both columns default to the same `now()` on INSERT,
     * while the ON CONFLICT branch above explicitly bumps only
     * `updatedAt`. This is the only signal used to distinguish a new
     * order from an update — no webhook-topic string (Shopify's
     * `orders/create` vs `orders/updated`) is inspected here, keeping
     * this provider-agnostic (doc06 — Provider Isolation) and correctly
     * idempotent on a retried/replayed delivery: a retry's upsert always
     * hits the ON CONFLICT branch for an order this call already
     * inserted, so it is never reported as new twice.
     */
    const isInserted = (row: { createdAt: Date; updatedAt: Date }) => row.createdAt.getTime() === row.updatedAt.getTime();
    const newlyInsertedOrderExternalIds = new Set(orderRows.filter(isInserted).map((row) => row.externalId));

    const variantIdByExternalId = await this.lookupIds(
      db,
      commerceProductVariants,
      workspaceId,
      provider,
      orders.flatMap((order) => order.lineItems.map((item) => item.variantExternalId)),
    );

    const lineItemValues = orders.flatMap((order) => {
      const orderId = orderIdByExternalId.get(order.externalId);
      if (!orderId) {
        return [];
      }
      return order.lineItems.map((item) => ({
        workspaceId,
        integrationId,
        provider,
        orderId,
        variantId: item.variantExternalId ? (variantIdByExternalId.get(item.variantExternalId) ?? null) : null,
        externalId: item.externalId,
        quantity: item.quantity,
        price: item.price,
      }));
    });

    let orderLineItemIdByExternalId = new Map<string, string>();
    if (lineItemValues.length > 0) {
      const lineItemRows = await db
        .insert(commerceOrderLineItems)
        .values(lineItemValues)
        .onConflictDoUpdate({
          target: [
            commerceOrderLineItems.workspaceId,
            commerceOrderLineItems.provider,
            commerceOrderLineItems.externalId,
          ],
          set: {
            variantId: sql`excluded.variant_id`,
            quantity: sql`excluded.quantity`,
            price: sql`excluded.price`,
            updatedAt: new Date(),
          },
        })
        .returning({ id: commerceOrderLineItems.id, externalId: commerceOrderLineItems.externalId });
      orderLineItemIdByExternalId = new Map(lineItemRows.map((row) => [row.externalId, row.id]));
    }

    const refundRows = await this.writeRefunds(
      db,
      workspaceId,
      integrationId,
      provider,
      orders.flatMap((order) => {
        const orderId = orderIdByExternalId.get(order.externalId);
        return orderId ? order.refunds.map((refund) => ({ ...refund, orderId })) : [];
      }),
      orderLineItemIdByExternalId,
    );

    const fulfillmentRows = orders.flatMap((order) => {
      const orderId = orderIdByExternalId.get(order.externalId);
      if (!orderId) {
        return [];
      }
      return order.fulfillments.map((fulfillment) => ({ ...fulfillment, orderId }));
    });
    const fulfillmentsWritten = await this.writeFulfillments(db, workspaceId, integrationId, provider, fulfillmentRows);

    const newOrderCanonicalCustomerIds = [
      ...new Set(
        (
          await this.canonicalIdsByCustomerId(
            db,
            orders
              .filter((order) => newlyInsertedOrderExternalIds.has(order.externalId) && order.customerExternalId)
              .map((order) => customerIdByExternalId.get(order.customerExternalId!))
              .filter((customerId): customerId is string => customerId !== undefined),
          )
        ).values(),
      ),
    ];

    const events: DomainEvent<OrderEventPayload>[] = [];
    if (emitDomainEvents) {
      const canonicalByCustomerId = await this.canonicalIdsByCustomerId(
        db,
        orderRows.map((row) => row.customerId).filter((id): id is string => id !== null),
      );
      const orderEvent = (row: OrderRef, sourceOccurredAt: Date | null) => orderEventPayload(provider, row, canonicalByCustomerId, sourceOccurredAt);
      const emit = <T extends OrderEventPayload>(type: string, idempotencyKey: string, payload: T) =>
        events.push(createEvent<T>({ type, workspaceId, entityId: payload.orderId, idempotencyKey, payload }));

      for (const row of orderRows) {
        const previous = previousByExternalId.get(row.externalId);
        if (isInserted(row)) {
          emit('order.created', `order.created:${row.id}`, orderEvent(row, row.sourceCreatedAt));
        } else if (previous && isNewerVersion(row.sourceUpdatedAt, previous.sourceUpdatedAt)) {
          emit('order.updated', `order.updated:${row.id}:${row.sourceUpdatedAt!.toISOString()}`, orderEvent(row, row.sourceUpdatedAt));
        }
        if (row.sourceCancelledAt && !previous?.sourceCancelledAt) {
          emit('order.cancelled', `order.cancelled:${row.id}`, orderEvent(row, row.sourceCancelledAt));
        }
      }
      events.push(...refundProcessedEvents(workspaceId, provider, refundRows, new Map(orderRows.map((row) => [row.id, row])), canonicalByCustomerId));
    }

    return {
      result: {
        ordersWritten: orders.length,
        lineItemsWritten: lineItemValues.length,
        refundsWritten: refundRows.length,
        fulfillmentsWritten,
        newOrderCanonicalCustomerIds,
      },
      events,
    };
  }

  /** The stored version/cancellation of each already-existing order in the batch, row-locked until the transaction ends. */
  private async lockPreviousState(db: NodePgDatabase, workspaceId: string, provider: IntegrationProvider, orders: NormalizedOrder[]) {
    const rows = await db
      .select({
        externalId: commerceOrders.externalId,
        sourceUpdatedAt: commerceOrders.sourceUpdatedAt,
        sourceCancelledAt: commerceOrders.sourceCancelledAt,
      })
      .from(commerceOrders)
      .where(
        and(
          eq(commerceOrders.workspaceId, workspaceId),
          eq(commerceOrders.provider, provider),
          inArray(
            commerceOrders.externalId,
            orders.map((order) => order.externalId),
          ),
        ),
      )
      .for('update');
    return new Map(rows.map((row) => [row.externalId, row]));
  }

  /** Maps internal commerce_customers ids to their linked canonical identity — omits any id Identity Resolution hasn't linked yet (`canonicalCustomerId IS NULL`). */
  private async canonicalIdsByCustomerId(db: NodePgDatabase, customerIds: string[]): Promise<Map<string, string>> {
    const uniqueCustomerIds = [...new Set(customerIds)];
    if (uniqueCustomerIds.length === 0) {
      return new Map();
    }

    const rows = await db
      .select({ id: commerceCustomers.id, canonicalCustomerId: commerceCustomers.canonicalCustomerId })
      .from(commerceCustomers)
      .where(inArray(commerceCustomers.id, uniqueCustomerIds));

    return new Map(rows.filter((row) => row.canonicalCustomerId !== null).map((row) => [row.id, row.canonicalCustomerId!]));
  }

  /**
   * Applies a standalone fulfillment webhook delivery (Shopify
   * `fulfillments/create`/`fulfillments/update` — unlike refunds, these are
   * their own webhook topics whose payload is the bare fulfillment plus
   * `order_id`, not a nested order). Resolves the order by external id
   * itself since, unlike `upsertMany`'s embedded case, no order was just
   * fetched/applied alongside it. No domain event: doc21 defines none for
   * fulfillments.
   */
  async upsertFulfillments(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    fulfillments: Array<NormalizedFulfillment & { orderExternalId: string }>,
  ): Promise<number> {
    if (fulfillments.length === 0) {
      return 0;
    }

    const db = this.database.client;
    const orderIdByExternalId = await this.lookupIds(
      db,
      commerceOrders,
      workspaceId,
      provider,
      fulfillments.map((f) => f.orderExternalId),
    );

    const rows = fulfillments.flatMap((fulfillment) => {
      const orderId = orderIdByExternalId.get(fulfillment.orderExternalId);
      if (!orderId) {
        return [];
      }
      return [{ ...fulfillment, orderId }];
    });

    return this.writeFulfillments(db, workspaceId, integrationId, provider, rows);
  }

  private async writeFulfillments(
    db: NodePgDatabase,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    fulfillments: Array<NormalizedFulfillment & { orderId: string }>,
  ): Promise<number> {
    if (fulfillments.length === 0) {
      return 0;
    }

    await db
      .insert(commerceFulfillments)
      .values(
        fulfillments.map((fulfillment) => ({
          workspaceId,
          integrationId,
          provider,
          orderId: fulfillment.orderId,
          externalId: fulfillment.externalId,
          status: fulfillment.status,
          trackingCompany: fulfillment.trackingCompany,
          trackingNumber: fulfillment.trackingNumber,
          trackingUrl: fulfillment.trackingUrl,
          shipmentStatus: fulfillment.shipmentStatus,
          sourceUpdatedAt: fulfillment.sourceUpdatedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [commerceFulfillments.workspaceId, commerceFulfillments.provider, commerceFulfillments.externalId],
        set: {
          orderId: sql`excluded.order_id`,
          status: sql`excluded.status`,
          trackingCompany: sql`excluded.tracking_company`,
          trackingNumber: sql`excluded.tracking_number`,
          trackingUrl: sql`excluded.tracking_url`,
          shipmentStatus: sql`excluded.shipment_status`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          updatedAt: new Date(),
        },
        setWhere: NOT_STALE('commerce_fulfillments'),
      });

    return fulfillments.length;
  }

  /**
   * Writes refund rows (embedded in an order payload) with
   * their line items, linked to the given orders. Returns the written
   * refund rows; one inserted by this call (rather than updated) is a
   * newly processed refund.
   */
  private async writeRefunds(
    db: NodePgDatabase,
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    refunds: Array<NormalizedRefund & { orderId: string }>,
    orderLineItemIdByExternalId: Map<string, string>,
  ) {
    const refundValues = refunds.map((refund) => ({
      workspaceId,
      integrationId,
      provider,
      orderId: refund.orderId,
      externalId: refund.externalId,
      note: refund.note,
      totalRefunded: refund.totalRefunded,
      processedAt: refund.processedAt,
    }));

    if (refundValues.length === 0) {
      return [];
    }

    const refundRows = await db
      .insert(commerceRefunds)
      .values(refundValues)
      .onConflictDoUpdate({
        target: [commerceRefunds.workspaceId, commerceRefunds.provider, commerceRefunds.externalId],
        set: {
          note: sql`excluded.note`,
          totalRefunded: sql`excluded.total_refunded`,
          processedAt: sql`excluded.processed_at`,
          updatedAt: new Date(),
        },
      })
      .returning({
        id: commerceRefunds.id,
        externalId: commerceRefunds.externalId,
        orderId: commerceRefunds.orderId,
        totalRefunded: commerceRefunds.totalRefunded,
        processedAt: commerceRefunds.processedAt,
        createdAt: commerceRefunds.createdAt,
        updatedAt: commerceRefunds.updatedAt,
      });
    const refundIdByExternalId = new Map(refundRows.map((row) => [row.externalId, row.id]));

    const refundLineItemValues = refunds.flatMap((refund) => {
      const refundId = refundIdByExternalId.get(refund.externalId);
      if (!refundId) {
        return [];
      }
      return refund.lineItems.map((item) => ({
        workspaceId,
        integrationId,
        provider,
        refundId,
        orderLineItemId: item.orderLineItemExternalId
          ? (orderLineItemIdByExternalId.get(item.orderLineItemExternalId) ?? null)
          : null,
        externalId: item.externalId,
        quantity: item.quantity,
      }));
    });

    if (refundLineItemValues.length > 0) {
      await db
        .insert(commerceRefundLineItems)
        .values(refundLineItemValues)
        .onConflictDoUpdate({
          target: [
            commerceRefundLineItems.workspaceId,
            commerceRefundLineItems.provider,
            commerceRefundLineItems.externalId,
          ],
          set: {
            orderLineItemId: sql`excluded.order_line_item_id`,
            quantity: sql`excluded.quantity`,
            updatedAt: new Date(),
          },
        });
    }

    return refundRows;
  }

  /** This workspace/provider's current `sourceUpdatedAt` for each existing order externalId (doc 06/20 — Reconciliation: detect missing/changed records before repairing; line-item-level drift isn't tracked separately). Absent from the map means no such row exists yet. */
  async findExistingUpdatedAt(
    workspaceId: string,
    provider: IntegrationProvider,
    externalIds: string[],
  ): Promise<Map<string, Date | null>> {
    if (externalIds.length === 0) {
      return new Map();
    }

    const rows = await this.database.client
      .select({ externalId: commerceOrders.externalId, sourceUpdatedAt: commerceOrders.sourceUpdatedAt })
      .from(commerceOrders)
      .where(
        and(
          eq(commerceOrders.workspaceId, workspaceId),
          eq(commerceOrders.provider, provider),
          inArray(commerceOrders.externalId, externalIds),
        ),
      );

    return new Map(rows.map((row) => [row.externalId, row.sourceUpdatedAt]));
  }

  /** Resolves a batch of external ids to this workspace/provider's existing row ids for `table`. */
  private async lookupIds(
    db: NodePgDatabase,
    table: typeof commerceCustomers | typeof commerceProductVariants | typeof commerceOrders,
    workspaceId: string,
    provider: IntegrationProvider,
    externalIds: (string | null)[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(externalIds.filter((value): value is string => value !== null))];
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await db
      .select({ id: table.id, externalId: table.externalId })
      .from(table)
      .where(and(eq(table.workspaceId, workspaceId), eq(table.provider, provider), inArray(table.externalId, ids)));

    return new Map(rows.map((row) => [row.externalId, row.id]));
  }
}
