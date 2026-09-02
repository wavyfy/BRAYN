import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { DatabaseService } from '../../database/database.service';
import { NotFoundError } from '../../common/errors/app-error';

const RECENT_ORDERS_LIMIT = 10;
const ACTIVITY_LIMIT = 50;

export interface CustomerProfile {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
}

export interface RecentOrder {
  provider: string;
  externalId: string;
  totalPrice: string | null;
  createdAt: Date;
}

export interface CommerceContext {
  ordersCount: number;
  totalSpent: string;
  lastOrderAt: Date | null;
  recentOrders: RecentOrder[];
}

export interface CustomerRecord {
  canonicalCustomerId: string;
  profile: CustomerProfile;
  /** Every source row this canonical customer resolves — doc08 "Activity entries should reference their source/domain" applies to the whole record, not just history. */
  sourceCustomers: { provider: string; externalId: string }[];
  commerceContext: CommerceContext;
}

/** A chronological event (doc08 — Customer Activity History: "Activity entries should reference their source/domain rather than becoming an independent source of business truth"). */
export type ActivityEntry =
  | { type: 'customer_created'; occurredAt: Date; provider: string; externalId: string }
  | { type: 'order_placed'; occurredAt: Date; provider: string; externalId: string; totalPrice: string | null };

interface SourceCustomerRow {
  id: string;
  provider: string;
  externalId: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  sourceUpdatedAt: Date | null;
  createdAt: Date;
}

/**
 * Reads the Unified Customer Intelligence Record (doc 08 — "unifies
 * relevant customer information across Commerce, Website behaviour,
 * Conversations..."). Phase 1: Customer profile + Commerce context +
 * Activity History synthesized from Commerce events only — Behavioural/
 * Conversation context need domains that don't exist yet (Website
 * Behaviour, Conversation), and preferences/memory/summary have no real
 * source yet (no AI, no conversations, no explicit merchant-input
 * pipeline); each is its own later part once its source exists.
 *
 * Pure aggregation, no duplicate storage (doc08 — "Domain-owned data may
 * remain in its owning domain and be referenced rather than duplicated";
 * "Canonical Customer Rule" — BRAYN must not maintain competing customer
 * intelligence representations). Reads canonical_customers +
 * commerce_customers/commerce_orders live on every call rather than
 * caching a copy.
 */
@Injectable()
export class CustomerIntelligenceService {
  constructor(private readonly database: DatabaseService) {}

  async getCustomer(workspaceId: string, canonicalCustomerId: string): Promise<CustomerRecord> {
    const canonical = await this.requireCanonical(workspaceId, canonicalCustomerId);
    const sourceRows = await this.getSourceRows(workspaceId, canonicalCustomerId);

    const profile: CustomerProfile = {
      email: canonical.primaryEmail,
      firstName: sourceRows.find((row) => row.firstName)?.firstName ?? null,
      lastName: sourceRows.find((row) => row.lastName)?.lastName ?? null,
      phone: sourceRows.find((row) => row.phone)?.phone ?? null,
    };

    return {
      canonicalCustomerId: canonical.id,
      profile,
      sourceCustomers: sourceRows.map((row) => ({ provider: row.provider, externalId: row.externalId })),
      commerceContext: await this.getCommerceContext(
        workspaceId,
        sourceRows.map((row) => row.id),
      ),
    };
  }

  /**
   * Chronological feed, newest first, capped at `ACTIVITY_LIMIT` (doc08
   * Customer Activity History examples: "Customer creation, Orders,
   * Purchases..."). Each `commerce_customers` row becomes one
   * `customer_created` entry (there can be more than one — a customer
   * connected across two providers has two source records, doc08 — each
   * entry keeps its own source, not a merged fiction); each order becomes
   * one `order_placed` entry, timed by the provider's own `sourceUpdatedAt`
   * where available (falling back to BRAYN's own `createdAt`).
   */
  async getActivity(workspaceId: string, canonicalCustomerId: string): Promise<ActivityEntry[]> {
    await this.requireCanonical(workspaceId, canonicalCustomerId);
    const sourceRows = await this.getSourceRows(workspaceId, canonicalCustomerId);
    const sourceCustomerIds = sourceRows.map((row) => row.id);

    const orders =
      sourceCustomerIds.length === 0
        ? []
        : await this.database.client
            .select({
              provider: commerceOrders.provider,
              externalId: commerceOrders.externalId,
              totalPrice: commerceOrders.totalPrice,
              sourceUpdatedAt: commerceOrders.sourceUpdatedAt,
              createdAt: commerceOrders.createdAt,
            })
            .from(commerceOrders)
            .where(and(eq(commerceOrders.workspaceId, workspaceId), inArray(commerceOrders.customerId, sourceCustomerIds)));

    const entries: ActivityEntry[] = [
      ...sourceRows.map(
        (row): ActivityEntry => ({
          type: 'customer_created',
          occurredAt: row.createdAt,
          provider: row.provider,
          externalId: row.externalId,
        }),
      ),
      ...orders.map(
        (order): ActivityEntry => ({
          type: 'order_placed',
          occurredAt: order.sourceUpdatedAt ?? order.createdAt,
          provider: order.provider,
          externalId: order.externalId,
          totalPrice: order.totalPrice,
        }),
      ),
    ];

    return entries.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, ACTIVITY_LIMIT);
  }

  private async requireCanonical(
    workspaceId: string,
    canonicalCustomerId: string,
  ): Promise<{ id: string; primaryEmail: string | null }> {
    const [canonical] = await this.database.client
      .select({ id: canonicalCustomers.id, primaryEmail: canonicalCustomers.primaryEmail })
      .from(canonicalCustomers)
      .where(and(eq(canonicalCustomers.workspaceId, workspaceId), eq(canonicalCustomers.id, canonicalCustomerId)))
      .limit(1);

    if (!canonical) {
      throw new NotFoundError('No customer with that id exists in this workspace.');
    }

    return canonical;
  }

  private async getSourceRows(workspaceId: string, canonicalCustomerId: string): Promise<SourceCustomerRow[]> {
    return this.database.client
      .select({
        id: commerceCustomers.id,
        provider: commerceCustomers.provider,
        externalId: commerceCustomers.externalId,
        firstName: commerceCustomers.firstName,
        lastName: commerceCustomers.lastName,
        phone: commerceCustomers.phone,
        sourceUpdatedAt: commerceCustomers.sourceUpdatedAt,
        createdAt: commerceCustomers.createdAt,
      })
      .from(commerceCustomers)
      .where(
        and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.canonicalCustomerId, canonicalCustomerId)),
      )
      .orderBy(desc(commerceCustomers.sourceUpdatedAt));
  }

  /** `sourceCustomerIds` are `commerce_customers.id` rows — `commerce_orders.customerId` links to those, not to the canonical customer directly. */
  private async getCommerceContext(workspaceId: string, sourceCustomerIds: string[]): Promise<CommerceContext> {
    if (sourceCustomerIds.length === 0) {
      return { ordersCount: 0, totalSpent: '0', lastOrderAt: null, recentOrders: [] };
    }

    const [summary] = await this.database.client
      .select({
        ordersCount: sql<number>`count(*)`,
        totalSpent: sql<string>`coalesce(sum(${commerceOrders.totalPrice}::numeric), 0)`,
        lastOrderAt: sql<Date | null>`max(${commerceOrders.sourceUpdatedAt})`,
      })
      .from(commerceOrders)
      .where(
        and(
          eq(commerceOrders.workspaceId, workspaceId),
          inArray(commerceOrders.customerId, sourceCustomerIds),
          isNotNull(commerceOrders.customerId),
        ),
      );

    const recentOrders = await this.database.client
      .select({
        provider: commerceOrders.provider,
        externalId: commerceOrders.externalId,
        totalPrice: commerceOrders.totalPrice,
        createdAt: commerceOrders.createdAt,
      })
      .from(commerceOrders)
      .where(and(eq(commerceOrders.workspaceId, workspaceId), inArray(commerceOrders.customerId, sourceCustomerIds)))
      .orderBy(desc(commerceOrders.createdAt))
      .limit(RECENT_ORDERS_LIMIT);

    return {
      ordersCount: Number(summary?.ordersCount ?? 0),
      totalSpent: summary?.totalSpent ?? '0',
      lastOrderAt: summary?.lastOrderAt ?? null,
      recentOrders,
    };
  }
}
