import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, notInArray, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { conversations } from '../../database/schema/conversations';
import { customerHealthStates } from '../../database/schema/customer-health-states';
import { customerMemoryEntries } from '../../database/schema/customer-memory-entries';
import { customerPreferences } from '../../database/schema/customer-preferences';
import { customerSummaries } from '../../database/schema/customer-summaries';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { identityMergeHistory, type MergeSnapshotCustomer } from '../../database/schema/identity-merge-history';
import { TERMINAL_STATUSES } from '../intelligence-engines/revenue-opportunity.service';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import {
  canonicalCustomerDuplicates,
  type IdentityConfidence,
  type IdentityReviewSignal,
} from '../../database/schema/canonical-customer-duplicates';
import { websiteVisitors } from '../../database/schema/website-visitors';
import { DatabaseService } from '../../database/database.service';
import { RequestContext } from '../../common/logging/request-context';
import { ConflictError, NotFoundError, UnauthenticatedError, ValidationError } from '../../common/errors/app-error';
import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

const REVIEW_INSERT_CHUNK = 1000;
const MERGE_REASON_MAX_LENGTH = 500;
/** `closedReason` on the merged customer's opportunities/recommendations a merge closes. */
export const MERGE_CLOSED_REASON = 'customer_merged';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 1 confidence per review signal (doc 09 "Confidence evaluation";
 * user decision Oct 23, 2026): exact normalized email is deterministic →
 * `high`; exact E.164 phone is possible → `medium`. The two conflict
 * signals carry a verified/deterministic email on both sides → `high`.
 * Names and other weak signals are never used. Only email ever links
 * automatically — nothing at any level merges automatically.
 */
export const REVIEW_SIGNAL_CONFIDENCE: Record<IdentityReviewSignal, IdentityConfidence> = {
  phone: 'medium',
  email_conflict: 'high',
  website_email_conflict: 'high',
};

type ReviewPair = { a: string; b: string; signal: IdentityReviewSignal; value: string };

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
 * A match on a customer that was merged into another resolves to the
 * survivor (`canonical_customers.mergedIntoId`), so a merged customer's
 * email seen again never links to — or re-creates — the merged row.
 *
 * Review queue (`canonical_customer_duplicates`, doc 09 "Duplicate
 * Customers" / "Conflicting identity signals require explicit handling"):
 * - Duplicate detection: a shared E.164 phone (`commerce_customers.
 *   phoneE164`, never the raw provider `phone`) across two *different*
 *   canonical customers is flagged `medium` for a human to review — never
 *   linked or merged on its own. Runs for every row in the batch, already-
 *   linked ones too, so a phone that changes on a later sync is checked.
 * - Conflicts: an already-linked source customer whose email now belongs
 *   to a different canonical customer (`email_conflict`), or an already-
 *   linked website visitor whose verified email does (`website_email_
 *   conflict`), is recorded `high` with both sides preserved — the
 *   existing link is never overwritten.
 * Owner/admin review: `dismiss()` or manual `merge()`.
 *
 * Anonymous → known linking (doc09/doc20 — Website Tracking Identity
 * Linking, Part 3): `resolveWebsiteVisitor()` links a `website_visitors`
 * row by the same normalized email match `resolveOne()` uses — the one
 * signal doc09 names — but lookup-only: it never creates a canonical
 * customer (see its own doc comment).
 *
 * ponytail: only ever resolves a row once (`canonicalCustomerId IS NULL`)
 * — if a customer's email later changes to one no other customer has, the
 * existing link isn't re-evaluated (a change to *another* customer's email
 * is recorded as a conflict). Add re-resolution if that turns out to matter.
 */
@Injectable()
export class IdentityResolutionService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Resolves every not-yet-linked row among `externalIds` for this
   * workspace/provider, then runs phone duplicate detection and email
   * conflict detection for every row in the batch. Safe to call repeatedly
   * with the same ids — an already-linked row keeps its link, and re-
   * flagging an already-recorded pair is a no-op (doc 20 Idempotency).
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
        canonicalEmail: canonicalCustomers.primaryEmail,
      })
      .from(commerceCustomers)
      .leftJoin(canonicalCustomers, eq(canonicalCustomers.id, commerceCustomers.canonicalCustomerId))
      .where(
        and(
          eq(commerceCustomers.workspaceId, workspaceId),
          eq(commerceCustomers.provider, provider),
          inArray(commerceCustomers.externalId, externalIds),
        ),
      );

    const withPhone: { canonicalCustomerId: string; phoneE164: string }[] = [];
    const changedEmail: { canonicalCustomerId: string; email: string }[] = [];
    for (const row of rows) {
      let canonicalCustomerId = row.canonicalCustomerId;
      if (!canonicalCustomerId) {
        canonicalCustomerId = await this.resolveOne(workspaceId, row.email);
        await this.database.client
          .update(commerceCustomers)
          .set({ canonicalCustomerId, updatedAt: new Date() })
          .where(eq(commerceCustomers.id, row.id));
      } else {
        const email = normalizeEmail(row.email);
        if (email && email !== row.canonicalEmail) {
          changedEmail.push({ canonicalCustomerId, email });
        }
      }

      if (row.phoneE164) {
        withPhone.push({ canonicalCustomerId, phoneE164: row.phoneE164 });
      }
    }

    await this.flagPhoneDuplicates(workspaceId, withPhone);
    await this.flagEmailConflicts(workspaceId, changedEmail, 'email_conflict');
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
   * `resolveMany`: an already-linked visitor is never re-linked. If its
   * verified email belongs to a *different* canonical customer, that is
   * recorded as a `website_email_conflict` for review (doc09 "Conflicting
   * identity signals require explicit handling") and the link is left as
   * is. A visitor id that doesn't exist in this workspace is a silent
   * no-op — tenant isolation, not an error worth surfacing to an already-
   * public, unauthenticated-by-Clerk ingestion path.
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
    if (!visitor) {
      return;
    }

    const normalizedEmail = email.trim().toLowerCase();
    if (visitor.canonicalCustomerId) {
      await this.flagEmailConflicts(workspaceId, [{ canonicalCustomerId: visitor.canonicalCustomerId, email: normalizedEmail }], 'website_email_conflict');
      return;
    }

    const [canonical] = await this.database.client
      .select({ id: canonicalCustomers.id, mergedIntoId: canonicalCustomers.mergedIntoId })
      .from(canonicalCustomers)
      .where(and(eq(canonicalCustomers.workspaceId, workspaceId), eq(canonicalCustomers.primaryEmail, normalizedEmail)))
      .limit(1);
    if (!canonical) {
      return;
    }

    await this.database.client
      .update(websiteVisitors)
      .set({ canonicalCustomerId: canonical.mergedIntoId ?? canonical.id, updatedAt: new Date() })
      .where(eq(websiteVisitors.id, visitor.id));
  }

  /** Pending review candidates (duplicates and conflicts) for a workspace — the review surface doc09's "Detection" bullet asks for. */
  async listDuplicates(workspaceId: string) {
    return this.database.client
      .select()
      .from(canonicalCustomerDuplicates)
      .where(and(eq(canonicalCustomerDuplicates.workspaceId, workspaceId), eq(canonicalCustomerDuplicates.status, 'pending')));
  }

  /**
   * Owner/admin dismisses a pending review candidate: status → `dismissed`,
   * recording who and when; signal, confidence and value are kept as
   * detected. The row stays, and the pair's unique index means detection
   * never re-creates the same candidate. Workspace-scoped: another
   * workspace's id is a 404, same as an unknown one.
   */
  async dismiss(workspaceId: string, duplicateId: string) {
    const actorUserId = RequestContext.get()?.actorUserId;
    if (!actorUserId) {
      throw new UnauthenticatedError();
    }
    if (!UUID_PATTERN.test(duplicateId)) {
      throw new NotFoundError('Duplicate candidate not found.');
    }

    const now = new Date();
    const [dismissed] = await this.database.client
      .update(canonicalCustomerDuplicates)
      .set({ status: 'dismissed', reviewedByUserId: actorUserId, reviewedAt: now, updatedAt: now })
      .where(
        and(
          eq(canonicalCustomerDuplicates.workspaceId, workspaceId),
          eq(canonicalCustomerDuplicates.id, duplicateId),
          eq(canonicalCustomerDuplicates.status, 'pending'),
        ),
      )
      .returning();
    if (dismissed) {
      return dismissed;
    }

    const [existing] = await this.database.client
      .select({ id: canonicalCustomerDuplicates.id })
      .from(canonicalCustomerDuplicates)
      .where(and(eq(canonicalCustomerDuplicates.workspaceId, workspaceId), eq(canonicalCustomerDuplicates.id, duplicateId)))
      .limit(1);
    throw existing ? new ConflictError('This candidate has already been reviewed.') : new NotFoundError('Duplicate candidate not found.');
  }

  /**
   * Owner/admin-approved manual merge of a pending review candidate (doc 09
   * "Safe merge"; user decisions Oct 23, 2026). Never automatic, never on
   * any signal alone — the candidate is only the reason a human looked.
   * The older canonical customer survives (tie → smaller id). One
   * transaction — any failure rolls the whole merge back:
   * - locks the candidate (must be `pending`) and both customers (same
   *   workspace, neither already merged);
   * - writes `identity_merge_history` with a pre-merge snapshot of both
   *   sides' identifiers, source records, visitors and the merged side's
   *   current health state;
   * - re-points identity links (`commerce_customers`, `website_visitors`)
   *   and `conversations` (messages untouched) to the survivor;
   * - re-points the merged customer's `customer_memory_entries` and
   *   `customer_preferences` to the survivor (id, content, provenance,
   *   creator, timestamps kept; their ids are in the snapshot; history
   *   untouched);
   * - removes the merged customer's *current* health state — every
   *   recalculation also appended it to `customer_health_state_history`,
   *   which is kept, and it's in the snapshot; the survivor is NOT
   *   recalculated here (the only recalculation path emits
   *   `customer_health.recalculated`, which runs automations — the
   *   existing on-demand recalculate endpoint covers it);
   * - removes the merged customer's AI summary (`customer_summaries`,
   *   derived, not snapshotted); the survivor's shows as stale until
   *   regenerated;
   * - closes the merged customer's open opportunities (`expired`) and
   *   active recommendations (`dismissed`), reason `customer_merged` —
   *   kept, never deleted; no detection is re-run;
   * - marks this candidate `merged` and every other pending candidate
   *   involving the merged customer `superseded` (signal/confidence kept);
   * - sets `mergedIntoId`/`mergedAt` on the merged customer (row kept,
   *   `primaryEmail` kept — resolution follows it to the survivor) and
   *   re-points anything previously merged into it, so it stays one hop.
   * `automation_runs` and `customer_health_state_history` stay on the
   * merged customer: execution/score history is never rewritten.
   */
  async merge(workspaceId: string, duplicateId: string, reason?: string) {
    const actorUserId = RequestContext.get()?.actorUserId;
    if (!actorUserId) {
      throw new UnauthenticatedError();
    }
    if (!UUID_PATTERN.test(duplicateId)) {
      throw new NotFoundError('Duplicate candidate not found.');
    }
    const trimmedReason = reason?.trim() || null;
    if (trimmedReason && trimmedReason.length > MERGE_REASON_MAX_LENGTH) {
      throw new ValidationError(`Reason must be at most ${MERGE_REASON_MAX_LENGTH} characters.`);
    }

    return this.database.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(canonicalCustomerDuplicates)
        .where(and(eq(canonicalCustomerDuplicates.workspaceId, workspaceId), eq(canonicalCustomerDuplicates.id, duplicateId)))
        .for('update');
      if (!candidate) {
        throw new NotFoundError('Duplicate candidate not found.');
      }
      if (candidate.status !== 'pending') {
        throw new ConflictError('This candidate has already been reviewed.');
      }

      const pair = await tx
        .select()
        .from(canonicalCustomers)
        .where(and(eq(canonicalCustomers.workspaceId, workspaceId), inArray(canonicalCustomers.id, [candidate.canonicalCustomerAId, candidate.canonicalCustomerBId])))
        .for('update');
      if (pair.length !== 2) {
        throw new NotFoundError('Both customers must exist in this workspace.');
      }
      if (pair.some((customer) => customer.mergedIntoId)) {
        throw new ConflictError('One of these customers has already been merged.');
      }
      const [surviving, merged] = [...pair].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime() || x.id.localeCompare(y.id));

      const snapshotOf = async (customer: (typeof pair)[number]): Promise<MergeSnapshotCustomer> => {
        const sourceRecords = await tx
          .select({
            commerceCustomerId: commerceCustomers.id,
            provider: commerceCustomers.provider,
            externalId: commerceCustomers.externalId,
            email: commerceCustomers.email,
            phone: commerceCustomers.phone,
            phoneE164: commerceCustomers.phoneE164,
          })
          .from(commerceCustomers)
          .where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.canonicalCustomerId, customer.id)));
        const visitors = await tx
          .select({ id: websiteVisitors.id })
          .from(websiteVisitors)
          .where(and(eq(websiteVisitors.workspaceId, workspaceId), eq(websiteVisitors.canonicalCustomerId, customer.id)));
        const memoryEntries = await tx
          .select({ id: customerMemoryEntries.id })
          .from(customerMemoryEntries)
          .where(and(eq(customerMemoryEntries.workspaceId, workspaceId), eq(customerMemoryEntries.canonicalCustomerId, customer.id)));
        const preferenceRows = await tx
          .select({ id: customerPreferences.id })
          .from(customerPreferences)
          .where(and(eq(customerPreferences.workspaceId, workspaceId), eq(customerPreferences.canonicalCustomerId, customer.id)));
        return {
          canonicalCustomerId: customer.id,
          primaryEmail: customer.primaryEmail,
          createdAt: customer.createdAt.toISOString(),
          sourceRecords,
          websiteVisitorIds: visitors.map((visitor) => visitor.id),
          memoryEntryIds: memoryEntries.map((entry) => entry.id),
          preferenceIds: preferenceRows.map((row) => row.id),
        };
      };
      const [mergedHealthState] = await tx
        .select()
        .from(customerHealthStates)
        .where(and(eq(customerHealthStates.workspaceId, workspaceId), eq(customerHealthStates.canonicalCustomerId, merged.id)));

      const [history] = await tx
        .insert(identityMergeHistory)
        .values({
          workspaceId,
          survivingCanonicalCustomerId: surviving.id,
          mergedCanonicalCustomerId: merged.id,
          duplicateId: candidate.id,
          performedByUserId: actorUserId,
          matchedSignal: candidate.matchedSignal,
          confidence: candidate.confidence,
          reason: trimmedReason,
          snapshot: { surviving: await snapshotOf(surviving), merged: { ...(await snapshotOf(merged)), healthState: mergedHealthState ?? null } },
        })
        .returning();

      const now = new Date();
      const fromMerged = <T extends { workspaceId: AnyPgColumn; canonicalCustomerId: AnyPgColumn }>(table: T) =>
        and(eq(table.workspaceId, workspaceId), eq(table.canonicalCustomerId, merged.id));

      await tx.update(commerceCustomers).set({ canonicalCustomerId: surviving.id, updatedAt: now }).where(fromMerged(commerceCustomers));
      await tx.update(websiteVisitors).set({ canonicalCustomerId: surviving.id, updatedAt: now }).where(fromMerged(websiteVisitors));
      await tx.update(conversations).set({ canonicalCustomerId: surviving.id, updatedAt: now }).where(fromMerged(conversations));
      // Memory moves as-is (all statuses): updatedAt is pinned so it keeps meaning "content last changed", not "merged".
      await tx
        .update(customerMemoryEntries)
        .set({ canonicalCustomerId: surviving.id, updatedAt: sql`${customerMemoryEntries.updatedAt}` })
        .where(fromMerged(customerMemoryEntries));
      await tx
        .update(customerPreferences)
        .set({ canonicalCustomerId: surviving.id, updatedAt: sql`${customerPreferences.updatedAt}` })
        .where(fromMerged(customerPreferences));
      await tx.delete(customerHealthStates).where(fromMerged(customerHealthStates));
      // Derived and now describes a customer that no longer exists on its own; the survivor's summary turns stale by itself.
      await tx.delete(customerSummaries).where(fromMerged(customerSummaries));
      await tx
        .update(revenueOpportunities)
        .set({ status: 'expired', closedAt: now, closedReason: MERGE_CLOSED_REASON, updatedAt: now })
        .where(and(fromMerged(revenueOpportunities), notInArray(revenueOpportunities.status, [...TERMINAL_STATUSES])));
      await tx
        .update(recommendations)
        .set({ state: 'dismissed', closedAt: now, closedReason: MERGE_CLOSED_REASON, updatedAt: now })
        .where(and(fromMerged(recommendations), eq(recommendations.state, 'active')));

      await tx
        .update(canonicalCustomerDuplicates)
        .set({ status: 'merged', reviewedByUserId: actorUserId, reviewedAt: now, updatedAt: now })
        .where(eq(canonicalCustomerDuplicates.id, candidate.id));
      await tx
        .update(canonicalCustomerDuplicates)
        .set({ status: 'superseded', reviewedByUserId: actorUserId, reviewedAt: now, updatedAt: now })
        .where(
          and(
            eq(canonicalCustomerDuplicates.workspaceId, workspaceId),
            eq(canonicalCustomerDuplicates.status, 'pending'),
            or(eq(canonicalCustomerDuplicates.canonicalCustomerAId, merged.id), eq(canonicalCustomerDuplicates.canonicalCustomerBId, merged.id)),
          ),
        );

      await tx
        .update(canonicalCustomers)
        .set({ mergedIntoId: surviving.id, updatedAt: now })
        .where(and(eq(canonicalCustomers.workspaceId, workspaceId), eq(canonicalCustomers.mergedIntoId, merged.id)));
      await tx.update(canonicalCustomers).set({ mergedIntoId: surviving.id, mergedAt: now, updatedAt: now }).where(eq(canonicalCustomers.id, merged.id));

      return { survivingCanonicalCustomerId: surviving.id, mergedCanonicalCustomerId: merged.id, mergeHistoryId: history.id };
    });
  }

  /**
   * Finds or creates the canonical customer for one email (or the
   * no-email case). The insert's `onConflictDoUpdate` makes this a single
   * atomic round trip that's also race-safe: Postgres never conflicts two
   * NULL `primaryEmail` values against each other, so a `null` email
   * simply inserts a fresh row every time it's reached — correct, since
   * `resolveMany` only ever reaches an unresolved row once. A match on a
   * merged customer returns its survivor.
   */
  private async resolveOne(workspaceId: string, email: string | null): Promise<string> {
    const [row] = await this.database.client
      .insert(canonicalCustomers)
      .values({ workspaceId, primaryEmail: normalizeEmail(email) })
      .onConflictDoUpdate({
        target: [canonicalCustomers.workspaceId, canonicalCustomers.primaryEmail],
        set: { updatedAt: new Date() },
      })
      .returning({ id: canonicalCustomers.id, mergedIntoId: canonicalCustomers.mergedIntoId });

    return row.mergedIntoId ?? row.id;
  }

  /**
   * For each batch row, finds every *other* canonical customer in this
   * workspace with a source row sharing its E.164 phone, and records each
   * pairing as a `medium`-confidence candidate (`matchedValue` = the E.164
   * value). One lookup for the whole batch rather than one per row.
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

    const pairs: ReviewPair[] = [];
    for (const row of rows) {
      for (const other of sharing) {
        if (other.phoneE164 === row.phoneE164 && other.canonicalCustomerId) {
          pairs.push({ a: row.canonicalCustomerId, b: other.canonicalCustomerId, signal: 'phone', value: row.phoneE164 });
        }
      }
    }
    await this.recordReviewPairs(workspaceId, pairs);
  }

  /**
   * For each already-linked identity (source customer or website visitor)
   * carrying an email, records a conflict if that email belongs to a
   * *different* canonical customer (following merges). Nothing is
   * re-linked; an email no customer has is not a conflict.
   */
  private async flagEmailConflicts(
    workspaceId: string,
    rows: { canonicalCustomerId: string; email: string }[],
    signal: 'email_conflict' | 'website_email_conflict',
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const owners = await this.database.client
      .select({ id: canonicalCustomers.id, primaryEmail: canonicalCustomers.primaryEmail, mergedIntoId: canonicalCustomers.mergedIntoId })
      .from(canonicalCustomers)
      .where(and(eq(canonicalCustomers.workspaceId, workspaceId), inArray(canonicalCustomers.primaryEmail, [...new Set(rows.map((row) => row.email))])));
    const ownerByEmail = new Map(owners.map((owner) => [owner.primaryEmail, owner.mergedIntoId ?? owner.id]));

    const pairs: ReviewPair[] = [];
    for (const row of rows) {
      const owner = ownerByEmail.get(row.email);
      if (owner) {
        pairs.push({ a: row.canonicalCustomerId, b: owner, signal, value: row.email });
      }
    }
    await this.recordReviewPairs(workspaceId, pairs);
  }

  /**
   * Inserts review candidates, skipping self-pairs and collapsing repeats.
   * Idempotent — an already-recorded pair+signal (pending or reviewed) is
   * left untouched via the unique index. Chunked: one phone shared by many
   * customers (e.g. a store's own number) can yield thousands of pairs,
   * past Postgres' 65,535 bind-parameter limit in one insert.
   */
  private async recordReviewPairs(workspaceId: string, pairs: ReviewPair[]): Promise<void> {
    const values = new Map<string, typeof canonicalCustomerDuplicates.$inferInsert>();
    for (const { a: first, b: second, signal, value } of pairs) {
      if (first === second) {
        continue;
      }
      const [a, b] = [first, second].sort();
      values.set(`${a}:${b}:${signal}`, {
        workspaceId,
        canonicalCustomerAId: a,
        canonicalCustomerBId: b,
        matchedSignal: signal,
        confidence: REVIEW_SIGNAL_CONFIDENCE[signal],
        matchedValue: value,
      });
    }

    const rows = [...values.values()];
    for (let i = 0; i < rows.length; i += REVIEW_INSERT_CHUNK) {
      await this.database.client
        .insert(canonicalCustomerDuplicates)
        .values(rows.slice(i, i + REVIEW_INSERT_CHUNK))
        .onConflictDoNothing();
    }
  }
}

function normalizeEmail(email: string | null): string | null {
  return email ? email.trim().toLowerCase() : null;
}
