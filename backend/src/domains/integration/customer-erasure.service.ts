import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DatabaseService } from '../../database/database.service';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { customerErasures } from '../../database/schema/customer-erasures';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { checkoutSessions } from '../../database/schema/checkout-sessions';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { websiteEvents } from '../../database/schema/website-events';
import { websiteSessions } from '../../database/schema/website-sessions';
import { websiteVisitors } from '../../database/schema/website-visitors';
import { NotFoundError } from '../../common/errors/app-error';
import {
  ErasedIdentifierService,
  emailIdentifier,
  orderIdentifier,
  sourceIdentifier,
  type ErasedIdentifier,
} from '../commerce/erased-identifier.service';
import { IntegrationService } from './integration.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Bounds the merge-chain walks below; real chains are 1–2 deep. */
const MAX_MERGE_DEPTH = 20;

export interface CustomerErasureResult {
  canonicalCustomerId: string;
  sourceCustomersErased: number;
  ordersErased: number;
  webhookPayloadsCleared: number;
  identifiersBlocked: number;
}

/**
 * Person-level customer erasure (Stage 10 erasure slices 2–3): one canonical customer — the whole person, across
 * every connected provider in the workspace, including guest and merged identities — erased in one transaction.
 *
 * Reuses the existing purge building blocks (IntegrationService.deleteSourceCustomerWithOrders,
 * purgeCanonicalCustomerIfOrphaned — the same ones Shopify `customers/redact` uses, so every table they cover is
 * covered here too), and adds what a per-record purge lacks:
 * - every source record linked to the person (registered, guest, other providers, merged-in customers);
 * - the erased identifiers (emails, provider customer ids, order ids) go on the HMAC block list, so imports, syncs,
 *   reconciliation and webhooks never recreate them (ErasedIdentifierService);
 * - raw webhook payloads carrying the person's data are cleared — rows kept, so delivery de-duplication still works;
 * - a non-personal audit record (`customer_erasures`).
 *
 * Concurrency: takes the workspace's erasure lock exclusively before reading anything, so in-flight ingestion
 * finishes first (and is erased with the rest) and later ingestion sees the block list.
 *
 * Shopify `customers/redact` is unchanged — it still erases one source record via purgeCommerceCustomer.
 */
@Injectable()
export class CustomerErasureService {
  constructor(
    private readonly database: DatabaseService,
    private readonly integrationService: IntegrationService,
    private readonly erasedIdentifiers: ErasedIdentifierService,
  ) {}

  async eraseCanonicalCustomer(
    workspaceId: string,
    canonicalCustomerId: string,
    actorUserId: string,
  ): Promise<CustomerErasureResult> {
    if (!UUID_PATTERN.test(canonicalCustomerId)) {
      throw new NotFoundError('Customer not found.');
    }
    this.erasedIdentifiers.requireConfigured();

    return this.database.transaction(async (tx) => {
      await this.erasedIdentifiers.lockExclusive(tx, workspaceId);

      const rootId = await this.resolveSurvivor(tx, workspaceId, canonicalCustomerId);
      const personIds = await this.withMergedIn(tx, workspaceId, rootId);

      const canonicalRows = await tx
        .select({ primaryEmail: canonicalCustomers.primaryEmail })
        .from(canonicalCustomers)
        .where(
          and(
            eq(canonicalCustomers.workspaceId, workspaceId),
            inArray(canonicalCustomers.id, personIds),
          ),
        );
      const sourceColumns = {
        id: commerceCustomers.id,
        integrationId: commerceCustomers.integrationId,
        provider: commerceCustomers.provider,
        externalId: commerceCustomers.externalId,
        email: commerceCustomers.email,
        phoneE164: commerceCustomers.phoneE164,
      };
      const linked = await tx
        .select(sourceColumns)
        .from(commerceCustomers)
        .where(
          and(
            eq(commerceCustomers.workspaceId, workspaceId),
            inArray(commerceCustomers.canonicalCustomerId, personIds),
          ),
        );

      const emails = [
        ...new Set(
          [...canonicalRows.map((row) => row.primaryEmail), ...linked.map((row) => row.email)]
            .map((email) => emailIdentifier(email)?.value)
            .filter((email): email is string => !!email),
        ),
      ];
      // Plus not-yet-resolved rows carrying one of the person's emails (e.g. written just before this erasure took the
      // lock, before identity resolution ran) — resolution would otherwise link them to a fresh canonical afterwards.
      const unresolved =
        emails.length > 0
          ? await tx
              .select(sourceColumns)
              .from(commerceCustomers)
              .where(
                and(
                  eq(commerceCustomers.workspaceId, workspaceId),
                  isNull(commerceCustomers.canonicalCustomerId),
                  sql`lower(trim(${commerceCustomers.email})) in ${emails}`,
                ),
              )
          : [];
      const sources = [...linked, ...unresolved];
      const phones = [
        ...new Set(
          sources.map((source) => source.phoneE164).filter((phone): phone is string => !!phone),
        ),
      ];
      const webhookPayloadsCleared = await this.clearWebhookPayloads(
        tx,
        workspaceId,
        sources,
        emails,
        phones,
      );
      await this.eraseWebsiteIdentityData(tx, workspaceId, personIds, emails);
      // Checkout signals (FlexyPe): linked to the person, or still unlinked but carrying one of their emails/phones, or
      // unlinked but tied to one of their own orders by the provider session id (read before the orders are deleted).
      const orderSessionIds =
        sources.length > 0
          ? (
              await tx
                .selectDistinct({ id: commerceOrders.externalCheckoutSessionId })
                .from(commerceOrders)
                .where(
                  and(
                    eq(commerceOrders.workspaceId, workspaceId),
                    inArray(
                      commerceOrders.customerId,
                      sources.map((source) => source.id),
                    ),
                  ),
                )
            ).flatMap((row) => (row.id ? [row.id] : []))
          : [];
      await tx
        .delete(checkoutSessions)
        .where(
          and(
            eq(checkoutSessions.workspaceId, workspaceId),
            or(
              inArray(checkoutSessions.canonicalCustomerId, personIds),
              emails.length > 0 ? inArray(checkoutSessions.email, emails) : undefined,
              phones.length > 0 ? inArray(checkoutSessions.phoneE164, phones) : undefined,
              orderSessionIds.length > 0
                ? and(
                    inArray(checkoutSessions.externalSessionId, orderSessionIds),
                    isNull(checkoutSessions.canonicalCustomerId),
                  )
                : undefined,
            ),
          ),
        );

      const identifiers: ErasedIdentifier[] = [
        ...emails.map((email) => emailIdentifier(email)!),
        ...sources.map((source) => sourceIdentifier(source.provider, source.externalId)),
      ];
      let ordersErased = 0;
      for (const source of sources) {
        const orderExternalIds = await this.integrationService.deleteSourceCustomerWithOrders(
          tx,
          workspaceId,
          source.id,
        );
        ordersErased += orderExternalIds.length;
        identifiers.push(
          ...orderExternalIds.map((externalId) => orderIdentifier(source.provider, externalId)),
        );
      }
      const identifiersBlocked = await this.erasedIdentifiers.record(tx, workspaceId, identifiers);

      // Every source row is gone, so the root (and the customers merged into it) is orphaned and fully purged.
      await this.integrationService.purgeCanonicalCustomerIfOrphaned(tx, workspaceId, rootId);

      const result: CustomerErasureResult = {
        canonicalCustomerId: rootId,
        sourceCustomersErased: sources.length,
        ordersErased,
        webhookPayloadsCleared,
        identifiersBlocked,
      };
      await tx.insert(customerErasures).values({ workspaceId, actorUserId, ...result });
      return result;
    });
  }

  /** The surviving customer for a (possibly merged) id — a merged customer is the same person as its survivor. Locks the row. */
  private async resolveSurvivor(
    tx: NodePgDatabase,
    workspaceId: string,
    canonicalCustomerId: string,
  ): Promise<string> {
    let id = canonicalCustomerId;
    for (let depth = 0; depth < MAX_MERGE_DEPTH; depth++) {
      const [row] = await tx
        .select({ id: canonicalCustomers.id, mergedIntoId: canonicalCustomers.mergedIntoId })
        .from(canonicalCustomers)
        .where(and(eq(canonicalCustomers.workspaceId, workspaceId), eq(canonicalCustomers.id, id)))
        .for('update');
      if (!row) {
        throw new NotFoundError('Customer not found.');
      }
      if (!row.mergedIntoId) {
        return row.id;
      }
      id = row.mergedIntoId;
    }
    throw new Error('Customer merge chain is deeper than expected.');
  }

  /** The survivor plus every customer merged into it, at any depth. */
  private async withMergedIn(
    tx: NodePgDatabase,
    workspaceId: string,
    rootId: string,
  ): Promise<string[]> {
    const all = [rootId];
    let frontier = [rootId];
    for (let depth = 0; depth < MAX_MERGE_DEPTH && frontier.length > 0; depth++) {
      const merged = await tx
        .select({ id: canonicalCustomers.id })
        .from(canonicalCustomers)
        .where(
          and(
            eq(canonicalCustomers.workspaceId, workspaceId),
            inArray(canonicalCustomers.mergedIntoId, frontier),
          ),
        );
      frontier = merged.map((row) => row.id).filter((id) => !all.includes(id));
      all.push(...frontier);
    }
    return all;
  }

  /**
   * Website identity data carrying the erased emails (`identity_signal` events store `{ email, verified }`), beyond
   * the visitors linked to the person (purgeCanonicalCustomerIfOrphaned deletes those): a visitor that sent one of
   * the emails but was never linked (unsigned signal, or sent before the customer existed) is this person's browsing
   * data — deleted with its sessions and events. A visitor linked to a *different* customer keeps its own history;
   * only the identity events carrying the erased email are removed.
   */
  private async eraseWebsiteIdentityData(
    tx: NodePgDatabase,
    workspaceId: string,
    personIds: string[],
    emails: string[],
  ): Promise<void> {
    if (emails.length === 0) {
      return;
    }
    const carriesErasedEmail = and(
      eq(websiteEvents.workspaceId, workspaceId),
      eq(websiteEvents.eventType, 'identity_signal'),
      sql`lower(trim(${websiteEvents.payload}->>'email')) in ${emails}`,
    );
    const visitors = await tx
      .selectDistinct({
        id: websiteVisitors.id,
        canonicalCustomerId: websiteVisitors.canonicalCustomerId,
      })
      .from(websiteEvents)
      .innerJoin(websiteVisitors, eq(websiteVisitors.id, websiteEvents.visitorId))
      .where(carriesErasedEmail);
    const wholeVisitorIds = visitors
      .filter(
        (visitor) =>
          visitor.canonicalCustomerId === null || personIds.includes(visitor.canonicalCustomerId),
      )
      .map((visitor) => visitor.id);

    await tx.delete(websiteEvents).where(carriesErasedEmail);
    if (wholeVisitorIds.length > 0) {
      // events → sessions → visitors (FK), same order as purgeCanonicalCustomerIfOrphaned.
      await tx
        .delete(websiteEvents)
        .where(
          and(
            eq(websiteEvents.workspaceId, workspaceId),
            inArray(websiteEvents.visitorId, wholeVisitorIds),
          ),
        );
      await tx
        .delete(websiteSessions)
        .where(
          and(
            eq(websiteSessions.workspaceId, workspaceId),
            inArray(websiteSessions.visitorId, wholeVisitorIds),
          ),
        );
      await tx
        .delete(websiteVisitors)
        .where(
          and(
            eq(websiteVisitors.workspaceId, workspaceId),
            inArray(websiteVisitors.id, wholeVisitorIds),
          ),
        );
    }
  }

  /**
   * Clears the stored payload (and error) of every webhook row in this workspace that carries this person's data:
   * customer events for their source records or emails, order events linked to them (guest orders included), and
   * checkout signals (FlexyPe) carrying one of their emails or E.164 phones.
   * Rows are kept so the provider's delivery id still de-duplicates a retry. Rows not yet processed are marked
   * processed — nothing is left to apply; a row a worker already claimed completes as a no-op (null payload).
   */
  private async clearWebhookPayloads(
    tx: NodePgDatabase,
    workspaceId: string,
    sources: Array<{ integrationId: string; externalId: string }>,
    emails: string[],
    phones: string[],
  ): Promise<number> {
    const byIntegration = new Map<string, string[]>();
    for (const source of sources) {
      byIntegration.set(source.integrationId, [
        ...(byIntegration.get(source.integrationId) ?? []),
        source.externalId,
      ]);
    }
    const t = integrationWebhookEvents;
    const conditions = [...byIntegration].map(([integrationId, externalIds]) =>
      and(
        eq(t.integrationId, integrationId),
        sql`(
          (${t.payload}->>'resource' = 'customer' and ${t.payload}->'data'->>'externalId' in ${externalIds})
          or (${t.payload}->>'resource' = 'order' and ${t.payload}->'data'->>'customerExternalId' in ${externalIds})
        )`,
      ),
    );
    // A customer event or guest order carrying one of the emails, even under a source record that was never linked.
    if (emails.length > 0) {
      conditions.push(
        sql`(
          (${t.payload}->>'resource' = 'customer' and lower(trim(${t.payload}->'data'->>'email')) in ${emails})
          or (${t.payload}->>'resource' = 'order' and lower(trim(${t.payload}->'data'->'guestCustomer'->>'email')) in ${emails})
          or (${t.payload}->>'resource' = 'checkout' and ${t.payload}->'data'->>'email' in ${emails})
        )`,
      );
    }
    // Checkout signals are stored with the phone already in E.164 (FlexyPeAdapter), the same form as `phone_e164`.
    if (phones.length > 0) {
      conditions.push(
        sql`(${t.payload}->>'resource' = 'checkout' and ${t.payload}->'data'->>'phone' in ${phones})`,
      );
    }
    if (conditions.length === 0) {
      return 0;
    }

    const cleared = await tx
      .update(t)
      .set({
        payload: null,
        error: null,
        status: sql`case when ${t.status} in ('pending', 'dead_letter') then 'processed' else ${t.status} end`,
        processedAt: sql`coalesce(${t.processedAt}, now())`,
      })
      .where(
        and(
          eq(t.workspaceId, workspaceId),
          sql`${t.payload} is not null`,
          sql`(${sql.join(conditions, sql` or `)})`,
        ),
      )
      .returning({ id: t.id });
    return cleared.length;
  }
}
