import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { commerceOrderLineItems } from '../../database/schema/commerce-order-line-items';
import { commerceProductVariants } from '../../database/schema/commerce-product-variants';
import { DatabaseService } from '../../database/database.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

export interface NormalizedOrderLineItem {
  externalId: string;
  /** The variant's provider id, or null if the order line has no variant reference (e.g. a custom/removed line). */
  variantExternalId: string | null;
  quantity: number;
  price: string | null;
}

/** A provider's order record, already mapped into BRAYN's shape (doc 06 — Normalization output). */
export interface NormalizedOrder {
  externalId: string;
  /** The customer's provider id, or null for a guest-checkout order. */
  customerExternalId: string | null;
  totalPrice: string | null;
  sourceUpdatedAt: Date | null;
  lineItems: NormalizedOrderLineItem[];
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
  ): Promise<{ ordersWritten: number; lineItemsWritten: number }> {
    if (orders.length === 0) {
      return { ordersWritten: 0, lineItemsWritten: 0 };
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

    if (lineItemValues.length > 0) {
      await this.database.client
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
        });
    }

    return { ordersWritten: orders.length, lineItemsWritten: lineItemValues.length };
  }

  /** Resolves a batch of external ids to this workspace/provider's existing row ids for `table`. */
  private async lookupIds(
    table: typeof commerceCustomers | typeof commerceProductVariants,
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
