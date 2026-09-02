import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
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
 * Phase 1 matching rule: exact, case-insensitive email match within the
 * workspace — the one signal doc 09 calls out by name as deterministic.
 * No match (or no email) creates a new canonical customer rather than
 * guessing. Everything else doc09/doc19 Phase 5 lists — phone matching,
 * duplicate detection/merge, conflicting-signal handling, anonymous→known
 * linking, identity history/audit — is deliberately out of scope here;
 * add as its own part once this foundation exists.
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
   * workspace/provider. Safe to call repeatedly with the same ids — an
   * already-linked row is simply skipped (doc 20 Idempotency).
   */
  async resolveMany(workspaceId: string, provider: IntegrationProvider, externalIds: string[]): Promise<void> {
    if (externalIds.length === 0) {
      return;
    }

    const unresolved = await this.database.client
      .select({ id: commerceCustomers.id, email: commerceCustomers.email })
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
    }
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
}
