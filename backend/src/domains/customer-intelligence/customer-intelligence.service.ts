import { Injectable } from '@nestjs/common';
import { and, desc, eq, ilike, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders, orderPlacedAt } from '../../database/schema/commerce-orders';
import { websiteVisitors } from '../../database/schema/website-visitors';
import { websiteEvents } from '../../database/schema/website-events';
import { DatabaseService } from '../../database/database.service';
import { NotFoundError } from '../../common/errors/app-error';

const RECENT_ORDERS_LIMIT = 10;
const RECENT_WEBSITE_EVENTS_LIMIT = 10;
const ACTIVITY_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 20;

export interface CustomerListItem {
  canonicalCustomerId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface CustomerListPage {
  customers: CustomerListItem[];
  page: number;
  limit: number;
  hasMore: boolean;
}

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
  /** When the order was placed at the source (`orderPlacedAt()`), not when BRAYN stored it. */
  createdAt: Date;
}

export interface CommerceContext {
  ordersCount: number;
  totalSpent: string;
  lastOrderAt: Date | null;
  /** Orders in the trailing 90 days — the purchase-frequency signal input (doc10 — Customer Risk & Engagement State). */
  ordersLast90Days: number;
  recentOrders: RecentOrder[];
}

export interface WorkspaceCommerceSummary {
  customersCount: number;
  ordersCount: number;
  totalSpent: string;
}

export interface RecentWebsiteEvent {
  eventType: string;
  occurredAt: Date;
}

/**
 * doc08 UCIR "Behavioural context" — live-aggregated from Website
 * Behaviour (doc06/doc20/doc22), same pattern as `CommerceContext`. Only
 * ever populated for `website_visitors` rows a canonical customer has
 * actually been linked to (Part 3 —
 * `IdentityResolutionService.resolveWebsiteVisitor()`); an unlinked
 * (still-anonymous) visitor's activity is never exposed through a
 * customer record. Deliberately minimal — a direct rollup of what the
 * schema already records, not a derived/invented metric (no "engagement
 * score", no session duration, nothing doc10's Health engine would need
 * before it exists). `identity_signal` events are excluded from both
 * fields below — that event type carries the linking email itself
 * (already surfaced via `profile.email`), not a customer-facing
 * behaviour to report.
 */
export interface BehaviouralContext {
  eventsCount: number;
  lastActivityAt: Date | null;
  recentEvents: RecentWebsiteEvent[];
}

export interface CustomerRecord {
  canonicalCustomerId: string;
  profile: CustomerProfile;
  /** Every source row this canonical customer resolves — doc08 "Activity entries should reference their source/domain" applies to the whole record, not just history. */
  sourceCustomers: { provider: string; externalId: string }[];
  commerceContext: CommerceContext;
  behaviouralContext: BehaviouralContext;
}

/** A chronological event (doc08 — Customer Activity History: "Activity entries should reference their source/domain rather than becoming an independent source of business truth"). */
export type ActivityEntry =
  | { type: 'customer_created'; occurredAt: Date; provider: string; externalId: string }
  | { type: 'order_placed'; occurredAt: Date; provider: string; externalId: string; totalPrice: string | null }
  | { type: 'website_activity'; occurredAt: Date; eventType: string };

interface SourceCustomerRow {
  id: string;
  provider: string;
  externalId: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  sourceUpdatedAt: Date | null;
  sourceCreatedAt: Date | null;
}

/**
 * Reads the Unified Customer Intelligence Record (doc 08 — "unifies
 * relevant customer information across Commerce, Website behaviour,
 * Conversations..."). Customer profile + Commerce context + Behavioural
 * context (Website Behaviour Part 4) + Activity History synthesized from
 * Commerce and Website Behaviour events. Conversation context still
 * needs a domain that doesn't exist yet (Conversation), and preferences/
 * memory/summary have no real source yet (no AI, no conversations, no
 * explicit merchant-input pipeline); each is its own later part once its
 * source exists.
 *
 * Pure aggregation, no duplicate storage (doc08 — "Domain-owned data may
 * remain in its owning domain and be referenced rather than duplicated";
 * "Canonical Customer Rule" — BRAYN must not maintain competing customer
 * intelligence representations). Reads canonical_customers +
 * commerce_customers/commerce_orders + website_visitors/website_events
 * live on every call rather than caching a copy.
 */
@Injectable()
export class CustomerIntelligenceService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Customer list/search (doc19 Phase 8 — canonical UI scope). Search is
   * email-only (`canonical_customers.primary_email`) — the deterministic
   * field Identity Resolution already keys matching on; searching by
   * name too would mean joining/searching `commerce_customers` in the
   * same paginated query, deferred to keep this first slice simple.
   * Deliberately lightweight — email + name only, offset-paginated; full
   * commerce context lives on `getCustomer` for a selected customer, not
   * duplicated here.
   */
  async listCustomers(workspaceId: string, options: { search?: string; page?: number; limit?: number } = {}): Promise<CustomerListPage> {
    const page = Math.max(1, options.page ?? 1);
    const limit = options.limit ?? DEFAULT_LIST_LIMIT;

    const rows = await this.database.client
      .select({ id: canonicalCustomers.id, primaryEmail: canonicalCustomers.primaryEmail })
      .from(canonicalCustomers)
      .where(
        and(
          eq(canonicalCustomers.workspaceId, workspaceId),
          options.search ? ilike(canonicalCustomers.primaryEmail, `%${options.search}%`) : undefined,
        ),
      )
      .orderBy(desc(canonicalCustomers.createdAt))
      .limit(limit + 1)
      .offset((page - 1) * limit);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    if (pageRows.length === 0) {
      return { customers: [], page, limit, hasMore: false };
    }

    const ids = pageRows.map((row) => row.id);
    const nameRows = await this.database.client
      .select({ canonicalCustomerId: commerceCustomers.canonicalCustomerId, firstName: commerceCustomers.firstName, lastName: commerceCustomers.lastName })
      .from(commerceCustomers)
      .where(
        and(
          eq(commerceCustomers.workspaceId, workspaceId),
          inArray(commerceCustomers.canonicalCustomerId, ids),
          isNotNull(commerceCustomers.canonicalCustomerId),
        ),
      );

    const namesById = new Map<string, { firstName: string | null; lastName: string | null }>();
    for (const row of nameRows) {
      if (!row.canonicalCustomerId) continue;
      const existing = namesById.get(row.canonicalCustomerId);
      if (!existing) {
        namesById.set(row.canonicalCustomerId, { firstName: row.firstName, lastName: row.lastName });
      } else {
        existing.firstName ??= row.firstName;
        existing.lastName ??= row.lastName;
      }
    }

    return {
      customers: pageRows.map((row) => ({
        canonicalCustomerId: row.id,
        email: row.primaryEmail,
        firstName: namesById.get(row.id)?.firstName ?? null,
        lastName: namesById.get(row.id)?.lastName ?? null,
      })),
      page,
      limit,
      hasMore,
    };
  }

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
      behaviouralContext: await this.getBehaviouralContext(workspaceId, canonical.id),
    };
  }

  /**
   * Chronological feed, newest first, capped at `ACTIVITY_LIMIT` (doc08
   * Customer Activity History examples: "Customer creation, Orders,
   * Purchases..."). Each `commerce_customers` row becomes one
   * `customer_created` entry (there can be more than one — a customer
   * connected across two providers has two source records, doc08 — each
   * entry keeps its own source, not a merged fiction); each order becomes
   * one `order_placed` entry, timed by when it was placed at the source
   * (`orderPlacedAt()`). A `customer_created` entry is timed by the
   * provider's own "added to the store" time (`sourceCreatedAt`) and is
   * left out entirely when that is unknown (a legacy row) — BRAYN's own
   * row-insert time is when the store was connected/imported, not a
   * customer event, so using it would put an import timestamp into the
   * customer's history.
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
              placedAt: orderPlacedAt(),
            })
            .from(commerceOrders)
            .where(and(eq(commerceOrders.workspaceId, workspaceId), inArray(commerceOrders.customerId, sourceCustomerIds)));

    const visitorIds = await this.getLinkedVisitorIds(workspaceId, canonicalCustomerId);
    // Fetching only the ACTIVITY_LIMIT most recent website events (rather
    // than every one, unlike the orders query above) is deliberate, not
    // an inconsistency — doc22's own volume caution for this table ("large
    // event datasets should be designed separately from transactional
    // customer records") applies to the query shape too: no final merge
    // can ever need more than ACTIVITY_LIMIT of them.
    const websiteActivity = await this.getRecentWebsiteEvents(workspaceId, visitorIds, ACTIVITY_LIMIT);

    const entries: ActivityEntry[] = [
      ...sourceRows.flatMap((row): ActivityEntry[] =>
        row.sourceCreatedAt
          ? [{ type: 'customer_created', occurredAt: row.sourceCreatedAt, provider: row.provider, externalId: row.externalId }]
          : [],
      ),
      ...orders.map(
        (order): ActivityEntry => ({
          type: 'order_placed',
          occurredAt: order.placedAt,
          provider: order.provider,
          externalId: order.externalId,
          totalPrice: order.totalPrice,
        }),
      ),
      ...websiteActivity.map(
        (event): ActivityEntry => ({
          type: 'website_activity',
          occurredAt: event.occurredAt,
          eventType: event.eventType,
        }),
      ),
    ];

    return entries.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, ACTIVITY_LIMIT);
  }

  /** Workspace-wide commerce totals (doc11 Merchant Dashboard — "Customer activity", not per-customer). */
  async getWorkspaceSummary(workspaceId: string): Promise<WorkspaceCommerceSummary> {
    const [customerCount] = await this.database.client
      .select({ count: sql<number>`count(*)` })
      .from(canonicalCustomers)
      .where(eq(canonicalCustomers.workspaceId, workspaceId));

    const [orderSummary] = await this.database.client
      .select({
        ordersCount: sql<number>`count(*)`,
        totalSpent: sql<string>`coalesce(sum(${commerceOrders.totalPrice}::numeric), 0)`,
      })
      .from(commerceOrders)
      .where(eq(commerceOrders.workspaceId, workspaceId));

    return {
      customersCount: Number(customerCount?.count ?? 0),
      ordersCount: Number(orderSummary?.ordersCount ?? 0),
      totalSpent: orderSummary?.totalSpent ?? '0',
    };
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
        sourceCreatedAt: commerceCustomers.sourceCreatedAt,
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
      return { ordersCount: 0, totalSpent: '0', lastOrderAt: null, ordersLast90Days: 0, recentOrders: [] };
    }

    const [summary] = await this.database.client
      .select({
        ordersCount: sql<number>`count(*)`,
        totalSpent: sql<string>`coalesce(sum(${commerceOrders.totalPrice}::numeric), 0)`,
        lastOrderAt: sql<Date | null>`max(${orderPlacedAt()})`,
        ordersLast90Days: sql<number>`count(*) filter (where ${orderPlacedAt()} >= now() - interval '90 days')`,
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
        createdAt: orderPlacedAt(),
      })
      .from(commerceOrders)
      .where(and(eq(commerceOrders.workspaceId, workspaceId), inArray(commerceOrders.customerId, sourceCustomerIds)))
      .orderBy(desc(orderPlacedAt()))
      .limit(RECENT_ORDERS_LIMIT);

    return {
      ordersCount: Number(summary?.ordersCount ?? 0),
      totalSpent: summary?.totalSpent ?? '0',
      // `sql<Date | null>` is a compile-time-only claim — a raw aggregate fragment (unlike a typed
      // column select) comes back from pg as a string, not a Date; every caller (e.g.
      // RevenueOpportunityService) calls .getTime() on this expecting a real Date.
      lastOrderAt: summary?.lastOrderAt ? new Date(summary.lastOrderAt) : null,
      ordersLast90Days: Number(summary?.ordersLast90Days ?? 0),
      recentOrders,
    };
  }

  /**
   * `website_visitors` rows actually linked to this canonical customer
   * (Part 3 — `IdentityResolutionService.resolveWebsiteVisitor()`). An
   * empty result means either no website activity was ever captured for
   * this customer, or it exists but is still anonymous/unlinked — both
   * cases correctly expose nothing here, never a guess at which visitor
   * might belong to this customer.
   */
  private async getLinkedVisitorIds(workspaceId: string, canonicalCustomerId: string): Promise<string[]> {
    const rows = await this.database.client
      .select({ id: websiteVisitors.id })
      .from(websiteVisitors)
      .where(and(eq(websiteVisitors.workspaceId, workspaceId), eq(websiteVisitors.canonicalCustomerId, canonicalCustomerId)));

    return rows.map((row) => row.id);
  }

  /** Shared by `getBehaviouralContext` (limit 10) and `getActivity` (limit `ACTIVITY_LIMIT`) — same query, different caps. */
  private async getRecentWebsiteEvents(workspaceId: string, visitorIds: string[], limit: number): Promise<RecentWebsiteEvent[]> {
    if (visitorIds.length === 0) {
      return [];
    }

    return this.database.client
      .select({ eventType: websiteEvents.eventType, occurredAt: websiteEvents.occurredAt })
      .from(websiteEvents)
      .where(
        and(
          eq(websiteEvents.workspaceId, workspaceId),
          inArray(websiteEvents.visitorId, visitorIds),
          ne(websiteEvents.eventType, 'identity_signal'),
        ),
      )
      .orderBy(desc(websiteEvents.occurredAt))
      .limit(limit);
  }

  private async getBehaviouralContext(workspaceId: string, canonicalCustomerId: string): Promise<BehaviouralContext> {
    const visitorIds = await this.getLinkedVisitorIds(workspaceId, canonicalCustomerId);
    if (visitorIds.length === 0) {
      return { eventsCount: 0, lastActivityAt: null, recentEvents: [] };
    }

    const [summary] = await this.database.client
      .select({
        eventsCount: sql<number>`count(*)`,
        lastActivityAt: sql<Date | null>`max(${websiteEvents.occurredAt})`,
      })
      .from(websiteEvents)
      .where(
        and(
          eq(websiteEvents.workspaceId, workspaceId),
          inArray(websiteEvents.visitorId, visitorIds),
          ne(websiteEvents.eventType, 'identity_signal'),
        ),
      );

    const recentEvents = await this.getRecentWebsiteEvents(workspaceId, visitorIds, RECENT_WEBSITE_EVENTS_LIMIT);

    return {
      eventsCount: Number(summary?.eventsCount ?? 0),
      // Same raw-aggregate-comes-back-as-a-string caveat as getCommerceContext's lastOrderAt.
      lastActivityAt: summary?.lastActivityAt ? new Date(summary.lastActivityAt) : null,
      recentEvents,
    };
  }
}
