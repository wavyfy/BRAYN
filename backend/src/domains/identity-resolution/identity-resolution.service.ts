import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { canonicalCustomerDuplicates } from '../../database/schema/canonical-customer-duplicates';
import { websiteVisitors } from '../../database/schema/website-visitors';
import { DatabaseService } from '../../database/database.service';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

const DUPLICATE_INSERT_CHUNK = 1000;

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
 * review. Matching uses `commerce_customers.phoneE164` (E.164, recomputed
 * by CustomerService on every upsert), never the raw provider `phone`; a
 * number with no country code normalizes to null and is never matched.
 * Detection runs for every row in the batch — already-linked ones too —
 * so a phone that changes on a later sync is still checked. Confidence
 * evaluation, safe merge, and conflict handling stay out of scope; so
 * does identity history/audit.
 *
 * Anonymous → known linking (doc09/doc20 — Website Tracking Identity
 * Linking, Part 3): `resolveWebsiteVisitor()` links a `website_visitors`
 * row by the same normalized email match `resolveOne()` uses — the one
 * signal doc09 names — but lookup-only: it never creates a canonical
 * customer (see its own doc comment).
 *
 * ponytail: only ever resolves a row once (`canonicalCustomerId IS NULL`)
 * — if a customer's email later changes, the existing link isn't
 * re-evaluated. Add re-resolution-on-email-change if that turns out to
 * matter in practice; today it would need merge logic this part doesn't have.
 */
@Injectable()
export class IdentityResolutionService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Resolves every not-yet-linked row among `externalIds` for this
   * workspace/provider, then runs phone duplicate detection for every row
   * in the batch. Safe to call repeatedly with the same ids — an
   * already-linked row keeps its link, and re-flagging an already-recorded
   * pair is a no-op (doc 20 Idempotency).
   */
  async resolveMany(workspaceId: string, provider: IntegrationProvider, externalIds: string[]): Promise<void> {
    if (externalIds.length === 0) {
      return;
    }

    const rows = await this.database.client
      .select({
        id: commerceCustomers.id,
        email: commerceCustomers.email,
        phoneE164: commerceCustomers.phoneE164,
        canonicalCustomerId: commerceCustomers.canonicalCustomerId,
      })
      .from(commerceCustomers)
      .where(
        and(
          eq(commerceCustomers.workspaceId, workspaceId),
          eq(commerceCustomers.provider, provider),
          inArray(commerceCustomers.externalId, externalIds),
        ),
      );

    const withPhone: { canonicalCustomerId: string; phoneE164: string }[] = [];
    for (const row of rows) {
      let canonicalCustomerId = row.canonicalCustomerId;
      if (!canonicalCustomerId) {
        canonicalCustomerId = await this.resolveOne(workspaceId, row.email);
        await this.database.client
          .update(commerceCustomers)
          .set({ canonicalCustomerId, updatedAt: new Date() })
          .where(eq(commerceCustomers.id, row.id));
      }

      if (row.phoneE164) {
        withPhone.push({ canonicalCustomerId, phoneE164: row.phoneE164 });
      }
    }

    await this.flagPhoneDuplicates(workspaceId, withPhone);
  }

  /**
   * Links a Website Behaviour visitor to a canonical customer once a
   * reliable identity signal (email) is available for it (doc20 Identity
   * Linking: `Anonymous Visitor → Identity Signal → Identity Resolution
   * → Canonical Customer → Historical Behaviour Linked`). Callers pass
   * only a *verified* email (see `WebsiteEventIngestService`). Links only
   * to an *existing* canonical customer with that email — never creates
   * one: a website signal is not a customer source of its own, and
   * find-or-create here let any write-key holder mint canonical customers
   * at will. An unknown email leaves the visitor anonymous (a no-op); the
   * next verified signal after that customer exists links it.
   *
   * Only ever links a visitor once, same "resolves once" contract as
   * `resolveMany` (see this service's own ponytail note above): an
   * already-linked visitor (`canonicalCustomerId IS NOT NULL`) is left
   * untouched even if a later signal carries a different email — doc09
   * "Conflicting identity signals require explicit handling", not solved
   * here, same as email-change re-resolution isn't for commerce. A
   * visitor id that doesn't exist in this workspace is a silent no-op —
   * tenant isolation, not an error worth surfacing to an already-public,
   * unauthenticated-by-Clerk ingestion path.
   *
   * Never touches `website_events` — every event already references
   * `websiteVisitorId`, not a copy of its identity, so linking the one
   * visitor row associates its entire historical event history; nothing
   * is duplicated or rewritten.
   */
  async resolveWebsiteVisitor(workspaceId: string, websiteVisitorId: string, email: string): Promise<void> {
    const [visitor] = await this.database.client
      .select({ id: websiteVisitors.id, canonicalCustomerId: websiteVisitors.canonicalCustomerId })
      .from(websiteVisitors)
      .where(and(eq(websiteVisitors.workspaceId, workspaceId), eq(websiteVisitors.id, websiteVisitorId)))
      .limit(1);

    if (!visitor || visitor.canonicalCustomerId) {
      return;
    }

    const [canonical] = await this.database.client
      .select({ id: canonicalCustomers.id })
      .from(canonicalCustomers)
      .where(and(eq(canonicalCustomers.workspaceId, workspaceId), eq(canonicalCustomers.primaryEmail, email.trim().toLowerCase())))
      .limit(1);
    if (!canonical) {
      return;
    }
    const canonicalCustomerId = canonical.id;

    await this.database.client
      .update(websiteVisitors)
      .set({ canonicalCustomerId, updatedAt: new Date() })
      .where(eq(websiteVisitors.id, visitor.id));
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
   * For each batch row, finds every *other* canonical customer in this
   * workspace with a source row sharing its E.164 phone, and records each
   * pairing as a pending duplicate candidate (`matchedValue` = the E.164
   * value). One lookup for the whole batch rather than one per row.
   * Idempotent — re-flagging an already-recorded pair just no-ops via the
   * unique index.
   */
  private async flagPhoneDuplicates(workspaceId: string, rows: { canonicalCustomerId: string; phoneE164: string }[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const sharing = await this.database.client
      .selectDistinct({ phoneE164: commerceCustomers.phoneE164, canonicalCustomerId: commerceCustomers.canonicalCustomerId })
      .from(commerceCustomers)
      .where(
        and(
          eq(commerceCustomers.workspaceId, workspaceId),
          inArray(commerceCustomers.phoneE164, [...new Set(rows.map((row) => row.phoneE164))]),
          isNotNull(commerceCustomers.canonicalCustomerId),
        ),
      );

    const pairs = new Map<string, typeof canonicalCustomerDuplicates.$inferInsert>();
    for (const row of rows) {
      for (const other of sharing) {
        if (other.phoneE164 !== row.phoneE164 || !other.canonicalCustomerId || other.canonicalCustomerId === row.canonicalCustomerId) {
          continue;
        }
        const [a, b] = [row.canonicalCustomerId, other.canonicalCustomerId].sort();
        pairs.set(`${a}:${b}`, { workspaceId, canonicalCustomerAId: a, canonicalCustomerBId: b, matchedSignal: 'phone', matchedValue: row.phoneE164 });
      }
    }

    // Chunked: one phone shared by many customers (e.g. a store's own number) can yield thousands of pairs, past Postgres' 65,535 bind-parameter limit in one insert.
    const values = [...pairs.values()];
    for (let i = 0; i < values.length; i += DUPLICATE_INSERT_CHUNK) {
      await this.database.client
        .insert(canonicalCustomerDuplicates)
        .values(values.slice(i, i + DUPLICATE_INSERT_CHUNK))
        .onConflictDoNothing();
    }
  }
}
