import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { DatabaseService } from '../../database/database.service';
import { normalizePhoneE164 } from '../../common/identity/phone';
import { ErasedIdentifierService, emailIdentifier, sourceIdentifier } from './erased-identifier.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

/** A provider's customer record, already mapped into BRAYN's shape (doc 06 — Normalization output). */
export interface NormalizedCustomer {
  externalId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  sourceUpdatedAt: Date | null;
  /** When the provider says the customer was added to the store — see commerce_customers.sourceCreatedAt. */
  sourceCreatedAt: Date | null;
}

/**
 * A guest checkout's source customer, built by a provider adapter from one order's billing data (externalId
 * `guest:<normalized email>`). `billingAt` is when that order was placed — what decides which order's name/phone
 * is kept (see `upsertGuestMany`).
 */
export interface NormalizedGuestCustomer extends NormalizedCustomer {
  billingAt: Date | null;
}

type GuestField = 'firstName' | 'lastName' | 'phone';
type GuestValue = { value: string | null; at: Date | null };
const GUEST_FIELDS = [
  { field: 'firstName', at: 'guestFirstNameSourceAt', column: 'first_name', atColumn: 'guest_first_name_source_at' },
  { field: 'lastName', at: 'guestLastNameSourceAt', column: 'last_name', atColumn: 'guest_last_name_source_at' },
  { field: 'phone', at: 'guestPhoneSourceAt', column: 'phone', atColumn: 'guest_phone_source_at' },
] as const satisfies ReadonlyArray<{ field: GuestField; at: string; column: string; atColumn: string }>;

/** The rule `upsertGuestMany`'s SQL applies, in TS for in-batch merging: non-empty beats empty, then later order, then the greater value (byte order, as `COLLATE "C"`). */
export function guestValueWins(candidate: GuestValue, current: GuestValue): boolean {
  if (candidate.value === null) return false;
  if (current.value === null) return true;
  const a = candidate.at?.getTime() ?? -Infinity;
  const b = current.at?.getTime() ?? -Infinity;
  if (a !== b) return a > b;
  return Buffer.compare(Buffer.from(candidate.value), Buffer.from(current.value)) > 0;
}

/**
 * Owns normalized commerce customer records (doc 22 — Commerce data area).
 * Consumed by Integration's import/webhook pipeline; never the reverse
 * (doc 06 — Integration produces, the owning domain stores).
 */
@Injectable()
export class CustomerService {
  constructor(
    private readonly database: DatabaseService,
    private readonly erasedIdentifiers: ErasedIdentifierService,
  ) {}

  /**
   * Drops customers an erasure blocked (by provider id or email), inside the writing transaction and under the
   * shared erasure lock — see ErasedIdentifierService. Shared by both upserts below.
   */
  private async withoutErased<T extends { externalId: string; email: string | null }>(
    tx: NodePgDatabase,
    workspaceId: string,
    provider: IntegrationProvider,
    customers: T[],
  ): Promise<T[]> {
    await this.erasedIdentifiers.lockShared(tx, workspaceId);
    const candidates = customers.flatMap((customer) => [sourceIdentifier(provider, customer.externalId), emailIdentifier(customer.email)]);
    const isBlocked = await this.erasedIdentifiers.findBlocked(tx, workspaceId, candidates);
    return customers.filter((customer) => !isBlocked(sourceIdentifier(provider, customer.externalId)) && !isBlocked(emailIdentifier(customer.email)));
  }

  /**
   * Inserts or updates customers keyed on (workspace, provider, externalId)
   * — doc 20 Idempotency: "repeated imports" and "reconciliation" must not
   * create duplicate records. Returns the number of rows written.
   */
  async upsertMany(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    customers: NormalizedCustomer[],
  ): Promise<number> {
    if (customers.length === 0) {
      return 0;
    }

    return this.database.transaction(async (tx) => {
      const allowed = await this.withoutErased(tx, workspaceId, provider, customers);
      if (allowed.length === 0) {
        return 0;
      }
      await tx
        .insert(commerceCustomers)
        .values(
          allowed.map((customer) => ({
            workspaceId,
            integrationId,
            provider,
            ...customer,
            phoneE164: normalizePhoneE164(customer.phone),
          })),
        )
        .onConflictDoUpdate({
          target: [commerceCustomers.workspaceId, commerceCustomers.provider, commerceCustomers.externalId],
          set: {
            email: sql`excluded.email`,
            firstName: sql`excluded.first_name`,
            lastName: sql`excluded.last_name`,
            phone: sql`excluded.phone`,
            phoneE164: sql`excluded.phone_e164`,
            sourceUpdatedAt: sql`excluded.source_updated_at`,
            sourceCreatedAt: sql`excluded.source_created_at`,
            updatedAt: new Date(),
          },
        });

      return allowed.length;
    });
  }

  /**
   * Inserts or updates guest-checkout source customers (see `NormalizedGuestCustomer`). Unlike `upsertMany` (a
   * provider customer record is one versioned whole), each guest field holds the non-empty value from the newest order
   * that had one: a field is replaced only by a non-empty value from an order at least as new (`billingAt`, ties
   * broken by value) and is never cleared. The result does not depend on arrival order — within a batch (merged here
   * first; one insert can't touch a row twice) or across batches (the same rule in SQL against the stored per-field
   * `guest*SourceAt`). Email is the row's key and never changes.
   */
  async upsertGuestMany(
    workspaceId: string,
    integrationId: string,
    provider: IntegrationProvider,
    guests: NormalizedGuestCustomer[],
  ): Promise<void> {
    const merged = new Map<string, { email: string | null } & Record<GuestField, GuestValue>>();
    for (const guest of guests) {
      const current = merged.get(guest.externalId) ?? {
        email: guest.email,
        firstName: { value: null, at: null },
        lastName: { value: null, at: null },
        phone: { value: null, at: null },
      };
      for (const { field } of GUEST_FIELDS) {
        const candidate = { value: guest[field], at: guest.billingAt };
        if (guestValueWins(candidate, current[field])) current[field] = candidate;
      }
      merged.set(guest.externalId, current);
    }
    if (merged.size === 0) {
      return;
    }

    const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const { field, at, column, atColumn } of GUEST_FIELDS) {
      const stored = `(coalesce(commerce_customers.${atColumn}, '-infinity'), coalesce(commerce_customers.${column}, '') COLLATE "C")`;
      const incoming = `(coalesce(excluded.${atColumn}, '-infinity'), coalesce(excluded.${column}, '') COLLATE "C")`;
      const wins = `excluded.${column} IS NOT NULL AND (commerce_customers.${column} IS NULL OR ${incoming} > ${stored})`;
      set[field] = sql.raw(`CASE WHEN ${wins} THEN excluded.${column} ELSE commerce_customers.${column} END`);
      set[at] = sql.raw(`CASE WHEN ${wins} THEN excluded.${atColumn} ELSE commerce_customers.${atColumn} END`);
      if (field === 'phone') {
        set.phoneE164 = sql.raw(`CASE WHEN ${wins} THEN excluded.phone_e164 ELSE commerce_customers.phone_e164 END`);
      }
    }

    await this.database.transaction(async (tx) => {
      const allowed = await this.withoutErased(tx, workspaceId, provider, [...merged].map(([externalId, guest]) => ({ externalId, email: guest.email, guest })));
      if (allowed.length === 0) {
        return;
      }
      await tx
      .insert(commerceCustomers)
      .values(
        allowed.map(({ externalId, guest }) => ({
          workspaceId,
          integrationId,
          provider,
          externalId,
          email: guest.email,
          firstName: guest.firstName.value,
          lastName: guest.lastName.value,
          phone: guest.phone.value,
          phoneE164: normalizePhoneE164(guest.phone.value),
          guestFirstNameSourceAt: guest.firstName.value === null ? null : guest.firstName.at,
          guestLastNameSourceAt: guest.lastName.value === null ? null : guest.lastName.at,
          guestPhoneSourceAt: guest.phone.value === null ? null : guest.phone.at,
        })),
      )
      .onConflictDoUpdate({
        target: [commerceCustomers.workspaceId, commerceCustomers.provider, commerceCustomers.externalId],
        set,
      });
    });
  }

  /** This workspace/provider's current `sourceUpdatedAt` for each existing externalId (doc 06/20 — Reconciliation: detect missing/changed records before repairing). Absent from the map means no such row exists yet. */
  async findExistingUpdatedAt(
    workspaceId: string,
    provider: IntegrationProvider,
    externalIds: string[],
  ): Promise<Map<string, Date | null>> {
    if (externalIds.length === 0) {
      return new Map();
    }

    const rows = await this.database.client
      .select({ externalId: commerceCustomers.externalId, sourceUpdatedAt: commerceCustomers.sourceUpdatedAt })
      .from(commerceCustomers)
      .where(
        and(
          eq(commerceCustomers.workspaceId, workspaceId),
          eq(commerceCustomers.provider, provider),
          inArray(commerceCustomers.externalId, externalIds),
        ),
      );

    return new Map(rows.map((row) => [row.externalId, row.sourceUpdatedAt]));
  }
}
