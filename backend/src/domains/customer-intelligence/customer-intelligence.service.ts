import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { DatabaseService } from '../../database/database.service';
import { NotFoundError } from '../../common/errors/app-error';

const RECENT_ORDERS_LIMIT = 10;

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

/**
 * Reads the Unified Customer Intelligence Record (doc 08 — "unifies
 * relevant customer information across Commerce, Website behaviour,
 * Conversations..."). Phase 1: Customer profile + Commerce context only —
 * Behavioural/Conversation context need domains that don't exist yet
 * (Website Behaviour, Conversation), and Activity History/preferences/
 * memory/summary are new concepts with no schema anywhere yet; each is
 * its own later part.
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
    const [canonical] = await this.database.client
      .select({ id: canonicalCustomers.id, primaryEmail: canonicalCustomers.primaryEmail })
      .from(canonicalCustomers)
      .where(and(eq(canonicalCustomers.workspaceId, workspaceId), eq(canonicalCustomers.id, canonicalCustomerId)))
      .limit(1);

    if (!canonical) {
      throw new NotFoundError('No customer with that id exists in this workspace.');
    }

    const sourceRows = await this.database.client
      .select({
        id: commerceCustomers.id,
        provider: commerceCustomers.provider,
        externalId: commerceCustomers.externalId,
        firstName: commerceCustomers.firstName,
        lastName: commerceCustomers.lastName,
        phone: commerceCustomers.phone,
        sourceUpdatedAt: commerceCustomers.sourceUpdatedAt,
      })
      .from(commerceCustomers)
      .where(
        and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.canonicalCustomerId, canonicalCustomerId)),
      )
      .orderBy(desc(commerceCustomers.sourceUpdatedAt));

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
