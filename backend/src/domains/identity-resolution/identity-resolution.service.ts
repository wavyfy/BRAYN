import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { canonicalCustomerDuplicates } from '../../database/schema/canonical-customer-duplicates';
import { DatabaseService } from '../../database/database.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

/**
 * Links `commerce_customers` rows to a canonical customer identity (doc 09
 * — Identity Resolution: "Whether an incoming identity already exists",
 * "Which customer it belongs to"). Called by Integration's import/sync/
 * webhook/reconciliation pipeline right after CustomerService.upsertMany —
 * a separate call, not a call CustomerService makes itself, since Identity
 * Resolution is its own domain (doc 04 Rule 1 — "One Owner"; Commerce owns
 * source records, Identity Resolution owns who they belong to).
 *
 * Matching rule: exact, case-insensitive email match within the workspace
 * — the one signal doc 09 calls out by name as deterministic. No match
 * (or no email) creates a new canonical customer rather than guessing.
 *
 * Duplicate detection (doc 09 — "Duplicate Customers": "must not be
 * silently merged... The system should support: Detection..."): phone is
 * deliberately *not* used to link/merge canonical customers (doc09 —
 * "Conflicting identity signals require explicit handling", not solved
 * here) — instead, a shared phone across two *different* canonical
 * customers is flagged as a pending duplicate candidate for a human to
 * review. Confidence evaluation, safe merge, and conflict handling stay
 * out of scope; so does anonymous→known linking (needs the Website
 * Behaviour domain, not built yet) and identity history/audit.
 *
 * ponytail: only ever resolves a row once (`canonicalCustomerId IS NULL`)
 * — if a customer's email later changes, the existing link isn't
 * re-evaluated. Add re-resolution-on-email-change if that turns out to
 * matter in practice; today it would need merge logic this part doesn't have.
 * ponytail: phone matching is an exact string match on whatever the
 * provider sent — no E.164/format normalization. Add real phone
 * normalization if formatting differences turn out to hide real matches.
 */
@Injectable()
export class IdentityResolutionService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Resolves every not-yet-linked row among `externalIds` for this
   * workspace/provider. Safe to call repeatedly with the same ids — an
   * already-linked row is simply skipped (doc 20 Idempotency).
   */
  async resolveMany(workspaceId: string, provider: IntegrationProvider, externalIds: string[]): Promise<void> {
    if (externalIds.length === 0) {
      return;
    }

    const unresolved = await this.database.client
      .select({ id: commerceCustomers.id, email: commerceCustomers.email, phone: commerceCustomers.phone })
      .from(commerceCustomers)
      .where(
        and(
          eq(commerceCustomers.workspaceId, workspaceId),
          eq(commerceCustomers.provider, provider),
          inArray(commerceCustomers.externalId, externalIds),
          isNull(commerceCustomers.canonicalCustomerId),
        ),
      );

    for (const row of unresolved) {
      const canonicalCustomerId = await this.resolveOne(workspaceId, row.email);
      await this.database.client
        .update(commerceCustomers)
        .set({ canonicalCustomerId, updatedAt: new Date() })
        .where(eq(commerceCustomers.id, row.id));

      if (row.phone) {
        await this.flagPhoneDuplicates(workspaceId, canonicalCustomerId, row.phone);
      }
    }
  }

  /** Pending duplicate candidates for a workspace, newest first — the review surface doc09's "Detection" bullet asks for. */
  async listDuplicates(workspaceId: string) {
    return this.database.client
      .select()
      .from(canonicalCustomerDuplicates)
      .where(and(eq(canonicalCustomerDuplicates.workspaceId, workspaceId), eq(canonicalCustomerDuplicates.status, 'pending')));
  }

  /**
   * Finds or creates the canonical customer for one email (or the
   * no-email case). The insert's `onConflictDoUpdate` makes this a single
   * atomic round trip that's also race-safe: Postgres never conflicts two
   * NULL `primaryEmail` values against each other, so a `null` email
   * simply inserts a fresh row every time it's reached — correct, since
   * `resolveMany` only ever reaches an unresolved row once.
   */
  private async resolveOne(workspaceId: string, email: string | null): Promise<string> {
    const primaryEmail = email ? email.trim().toLowerCase() : null;

    const [row] = await this.database.client
      .insert(canonicalCustomers)
      .values({ workspaceId, primaryEmail })
      .onConflictDoUpdate({
        target: [canonicalCustomers.workspaceId, canonicalCustomers.primaryEmail],
        set: { updatedAt: new Date() },
      })
      .returning({ id: canonicalCustomers.id });

    return row.id;
  }

  /**
   * Finds every *other* canonical customer in this workspace with a
   * source row sharing this exact phone, and records each pairing as a
   * pending duplicate candidate. Idempotent — re-flagging an already-
   * recorded pair just no-ops via the unique index.
   */
  private async flagPhoneDuplicates(workspaceId: string, canonicalCustomerId: string, phone: string): Promise<void> {
    const others = await this.database.client
      .selectDistinct({ canonicalCustomerId: commerceCustomers.canonicalCustomerId })
      .from(commerceCustomers)
      .where(
        and(
          eq(commerceCustomers.workspaceId, workspaceId),
          eq(commerceCustomers.phone, phone),
          ne(commerceCustomers.canonicalCustomerId, canonicalCustomerId),
        ),
      );

    const otherIds = [...new Set(others.map((o) => o.canonicalCustomerId).filter((id): id is string => id !== null))];
    if (otherIds.length === 0) {
      return;
    }

    await this.database.client
      .insert(canonicalCustomerDuplicates)
      .values(
        otherIds.map((otherId) => {
          const [a, b] = [canonicalCustomerId, otherId].sort();
          return { workspaceId, canonicalCustomerAId: a, canonicalCustomerBId: b, matchedSignal: 'phone' as const, matchedValue: phone };
        }),
      )
      .onConflictDoNothing();
  }
}
