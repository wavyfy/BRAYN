import { Injectable } from '@nestjs/common';
import { and, isNull, lt, or, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { checkoutSessions } from '../../database/schema/checkout-sessions';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { ErasedIdentifierService, emailIdentifier } from '../commerce/erased-identifier.service';
import {
  IdentityResolutionService,
  linkUnresolvedCheckoutSessions,
} from '../identity-resolution/identity-resolution.service';
import type { NormalizedCheckoutSignal } from './provider-adapter.interface';

export interface RecordedCheckoutSession {
  /** False when this provider session was already recorded (one abandonment per session). */
  created: boolean;
  canonicalCustomerId: string | null;
}

/**
 * Stores checkout signals from an external checkout provider (doc06 "External Checkout & Payment Signal Sources") and
 * links them to existing customers. Rules (Nov 24, 2026 decision; doc09):
 * - link only to an EXISTING canonical customer, only by exact (trimmed, lower-cased) email — the same rule BRAYN uses
 *   for guest-checkout emails; a merged customer resolves to its survivor; never by phone; never creates or merges;
 * - an email an erasure blocked is treated as absent, and the session keeps no identifiers;
 * - identifiers are kept only on unlinked sessions (for a later link, erasure and retention), never next to a link;
 * - one row per provider session (the provider sends one abandonment per session); a redelivered session is a no-op.
 */
@Injectable()
export class CheckoutSessionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly erasedIdentifiers: ErasedIdentifierService,
    private readonly identityResolution: IdentityResolutionService,
  ) {}

  async record(
    workspaceId: string,
    integrationId: string,
    provider: 'flexype',
    signal: NormalizedCheckoutSignal,
  ): Promise<RecordedCheckoutSession> {
    return this.database.transaction(async (tx) => {
      await this.erasedIdentifiers.lockShared(tx, workspaceId);
      const email = emailIdentifier(signal.email);
      const isBlocked = await this.erasedIdentifiers.findBlocked(tx, workspaceId, [email]);
      const identity =
        email && isBlocked(email)
          ? { email: null, phone: null }
          : { email: email?.value ?? null, phone: signal.phone };

      const canonicalCustomerId = identity.email
        ? await this.identityResolution.findExistingCustomerIdByEmail(
            tx,
            workspaceId,
            identity.email,
          )
        : null;
      const [row] = await tx
        .insert(checkoutSessions)
        .values({
          workspaceId,
          integrationId,
          provider,
          externalSessionId: signal.sessionId,
          stage: signal.stage,
          abandonedAt: new Date(signal.occurredAt),
          currency: signal.currency,
          itemCount: signal.items.reduce((sum, item) => sum + item.quantity, 0),
          email: canonicalCustomerId ? null : identity.email,
          phoneE164: canonicalCustomerId ? null : identity.phone,
          canonicalCustomerId,
        })
        .onConflictDoNothing({
          target: [checkoutSessions.integrationId, checkoutSessions.externalSessionId],
        })
        .returning({ canonicalCustomerId: checkoutSessions.canonicalCustomerId });

      return { created: Boolean(row), canonicalCustomerId: row?.canonicalCustomerId ?? null };
    });
  }
}

type Db = DatabaseService['client'];

/** Default window for identifiers on unlinked checkout sessions — see applyCheckoutSessionRetention. */
export const DEFAULT_CHECKOUT_UNMATCHED_RETENTION_DAYS = 30;
/**
 * Default lifetime of an unlinked session that never matched a commerce order — see applyCheckoutSessionRetention.
 * Provisional (Nov 24, 2026): such a row is pseudonymous (the provider can map its session id back to a shopper) and no
 * BRAYN surface shows it, so it is deleted rather than kept indefinitely; 90 days leaves room for a late order.
 */
export const DEFAULT_CHECKOUT_UNMATCHED_RECORD_DAYS = 90;

/**
 * Daily maintenance for unlinked checkout sessions (run by the daily intelligence job — no new scheduler), across all
 * workspaces:
 * 1. late link: an unlinked session whose email now belongs to an existing canonical customer in the SAME workspace is
 *    linked (survivor of a merge), and its identifiers are cleared — same exact-email rule as `record`;
 * 2. retention: sessions still unlinked after `retentionDays` lose their email and phone;
 * 3. record deletion: sessions still unlinked after `recordDays` whose provider session id is on no commerce order in
 *    the same workspace are deleted (pseudonymous, unused). Linked or order-corroborated sessions stay as customer
 *    activity and follow the customer's lifecycle (erasure, redact, purge).
 * Erased emails can't be linked here: erasure deletes every session carrying them, and `record` never stores a blocked one.
 */
export async function applyCheckoutSessionRetention(
  db: Db,
  now: Date,
  retentionDays: number,
  recordDays: number = DEFAULT_CHECKOUT_UNMATCHED_RECORD_DAYS,
): Promise<{ linked: number; anonymized: number; payloadsCleared: number; deleted: number }> {
  const linked = await linkUnresolvedCheckoutSessions(db);
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const anonymized = await db
    .update(checkoutSessions)
    .set({ email: null, phoneE164: null, updatedAt: now })
    .where(
      and(
        isNull(checkoutSessions.canonicalCustomerId),
        lt(checkoutSessions.createdAt, cutoff),
        or(
          sql`${checkoutSessions.email} is not null`,
          sql`${checkoutSessions.phoneE164} is not null`,
        ),
      ),
    )
    .returning({ id: checkoutSessions.id });
  // A checkout delivery that never completed processing (dead-lettered, or stuck) still holds its minimized payload —
  // same window, so no copy outlives the session's own identifiers. Mirrors erasure: nothing left to apply.
  const payloadsCleared = await db
    .update(integrationWebhookEvents)
    .set({
      payload: null,
      error: null,
      status: sql`case when ${integrationWebhookEvents.status} in ('pending', 'dead_letter') then 'processed' else ${integrationWebhookEvents.status} end`,
      processedAt: sql`coalesce(${integrationWebhookEvents.processedAt}, now())`,
    })
    .where(
      and(
        sql`${integrationWebhookEvents.payload}->>'resource' = 'checkout'`,
        lt(integrationWebhookEvents.createdAt, cutoff),
      ),
    )
    .returning({ id: integrationWebhookEvents.id });
  const recordCutoff = new Date(now.getTime() - recordDays * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(checkoutSessions)
    .where(
      and(
        isNull(checkoutSessions.canonicalCustomerId),
        lt(checkoutSessions.createdAt, recordCutoff),
        sql`not exists (select 1 from ${commerceOrders} o where o.workspace_id = ${checkoutSessions.workspaceId} and o.external_checkout_session_id = ${checkoutSessions.externalSessionId})`,
      ),
    )
    .returning({ id: checkoutSessions.id });
  return {
    linked,
    anonymized: anonymized.length,
    payloadsCleared: payloadsCleared.length,
    deleted: deleted.length,
  };
}
