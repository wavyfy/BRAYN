import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { commerceOrderLineItems } from '../../database/schema/commerce-order-line-items';
import { commerceProductVariants } from '../../database/schema/commerce-product-variants';
import { commerceRefunds } from '../../database/schema/commerce-refunds';
import { commerceRefundLineItems } from '../../database/schema/commerce-refund-line-items';
import { commerceFulfillments } from '../../database/schema/commerce-fulfillments';
import { DatabaseService } from '../../database/database.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

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
  lineItems: NormalizedOrderLineItem[];
  refunds: NormalizedRefund[];
  fulfillments: NormalizedFulfillment[];
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
 */
@Injectable()
export class OrderService {
  constructor(private readonly database: DatabaseService) {}

  async upsertMany(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    orders: NormalizedOrder[],
  ): Promise<{ ordersWritten: number; lineItemsWritten: number; refundsWritten: number; fulfillmentsWritten: number }> {
    if (orders.length === 0) {
      return { ordersWritten: 0, lineItemsWritten: 0, refundsWritten: 0, fulfillmentsWritten: 0 };
    }

    const customerIdByExternalId = await this.lookupIds(
      commerceCustomers,
      workspaceId,
      provider,
      orders.map((order) => order.customerExternalId),
    );

    const orderRows = await this.database.client
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
        })),
      )
      .onConflictDoUpdate({
        target: [commerceOrders.workspaceId, commerceOrders.provider, commerceOrders.externalId],
        set: {
          customerId: sql`excluded.customer_id`,
          totalPrice: sql`excluded.total_price`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: commerceOrders.id, externalId: commerceOrders.externalId });

    const orderIdByExternalId = new Map(orderRows.map((row) => [row.externalId, row.id]));

    const variantIdByExternalId = await this.lookupIds(
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
      const lineItemRows = await this.database.client
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

    const refundsWritten = await this.upsertRefunds(
      workspaceId,
      integrationId,
      provider,
      orders,
      orderIdByExternalId,
      orderLineItemIdByExternalId,
    );

    const fulfillmentRows = orders.flatMap((order) => {
      const orderId = orderIdByExternalId.get(order.externalId);
      if (!orderId) {
        return [];
      }
      return order.fulfillments.map((fulfillment) => ({ ...fulfillment, orderId }));
    });
    const fulfillmentsWritten = await this.writeFulfillments(workspaceId, integrationId, provider, fulfillmentRows);

    return { ordersWritten: orders.length, lineItemsWritten: lineItemValues.length, refundsWritten, fulfillmentsWritten };
  }

  /**
   * Applies a standalone fulfillment webhook delivery (Shopify
   * `fulfillments/create`/`fulfillments/update` — unlike refunds, these are
   * their own webhook topics whose payload is the bare fulfillment plus
   * `order_id`, not a nested order). Resolves the order by external id
   * itself since, unlike `upsertMany`'s embedded case, no order was just
   * fetched/applied alongside it.
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

    const orderIdByExternalId = await this.lookupIds(
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

    return this.writeFulfillments(workspaceId, integrationId, provider, rows);
  }

  private async writeFulfillments(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    fulfillments: Array<NormalizedFulfillment & { orderId: string }>,
  ): Promise<number> {
    if (fulfillments.length === 0) {
      return 0;
    }

    await this.database.client
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
      });

    return fulfillments.length;
  }

  /**
   * Writes refunds embedded in each order's payload (see commerce_refunds'
   * doc comment — Shopify has no separate refund fetch/webhook, so this is
   * always driven from an already-fetched/applied order, not its own loop).
   */
  private async upsertRefunds(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    orders: NormalizedOrder[],
    orderIdByExternalId: Map<string, string>,
    orderLineItemIdByExternalId: Map<string, string>,
  ): Promise<number> {
    const refundValues = orders.flatMap((order) => {
      const orderId = orderIdByExternalId.get(order.externalId);
      if (!orderId) {
        return [];
      }
      return order.refunds.map((refund) => ({
        workspaceId,
        integrationId,
        provider,
        orderId,
        externalId: refund.externalId,
        note: refund.note,
        totalRefunded: refund.totalRefunded,
        processedAt: refund.processedAt,
      }));
    });

    if (refundValues.length === 0) {
      return 0;
    }

    const refundRows = await this.database.client
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
      .returning({ id: commerceRefunds.id, externalId: commerceRefunds.externalId });
    const refundIdByExternalId = new Map(refundRows.map((row) => [row.externalId, row.id]));

    const refundLineItemValues = orders.flatMap((order) => {
      return order.refunds.flatMap((refund) => {
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
    });

    if (refundLineItemValues.length > 0) {
      await this.database.client
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

    return refundValues.length;
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
    table: typeof commerceCustomers | typeof commerceProductVariants | typeof commerceOrders,
    workspaceId: string,
    provider: IntegrationProvider,
    externalIds: (string | null)[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(externalIds.filter((value): value is string => value !== null))];
    if (ids.length === 0) {
      return new Map();
    }

    const rows = await this.database.client
      .select({ id: table.id, externalId: table.externalId })
      .from(table)
      .where(and(eq(table.workspaceId, workspaceId), eq(table.provider, provider), inArray(table.externalId, ids)));

    return new Map(rows.map((row) => [row.externalId, row.id]));
  }
}
