import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { DatabaseService } from '../../../../database/database.service';
import { customerDataRequests } from '../../../../database/schema/customer-data-requests';
import { shopifyComplianceWebhooks } from '../../../../database/schema/shopify-compliance-webhooks';
import { ConflictError, NotFoundError, ProviderError, UnauthenticatedError, ValidationError } from '../../../../common/errors/app-error';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import { IntegrationService } from '../../integration.service';
import { verifyShopifyHmac } from './shopify.adapter';
import { complianceOpenIssueCounts } from './shopify-compliance-retention';
import { decryptCredential, encryptCredential, InvalidEncryptionKeyError, parseEncryptionKey } from '../../../../common/crypto/credential-cipher';
import type { Env } from '../../../../config/env.schema';

export const SHOPIFY_COMPLIANCE_TOPICS = ['customers/data_request', 'customers/redact', 'shop/redact'] as const;
export type ShopifyComplianceTopic = (typeof SHOPIFY_COMPLIANCE_TOPICS)[number];

/** A claim older than this is treated as abandoned (crashed or timed-out attempt) and may be retaken by a redelivery. */
const STALE_CLAIM_INTERVAL = sql`interval '5 minutes'`;

interface ShopifyComplianceCustomer {
  id?: number | string;
  email?: string;
}

interface ShopifyCompliancePayload {
  shop_id?: number | string;
  shop_domain?: string;
  customer?: ShopifyComplianceCustomer;
  orders_requested?: number[];
  orders_to_redact?: Array<number | string>;
}

type Outcome = 'erased' | 'nothing_found' | 'recorded' | 'unknown_shop';
type ExceptionReason = 'unknown_shop' | 'identity_conflict';
type Holder = { id: string; workspaceId: string; shopifyShopId: string | null };
type Claim = { webhookId: string; attempt: number };

/**
 * Shopify's three mandatory, app-level compliance webhooks (Shopify
 * Protected Customer Data — `customers/data_request`, `customers/redact`,
 * `shop/redact`). Deliberately separate from `WebhookIngestService`'s
 * per-workspace pipeline (doc 21) — that pipeline is keyed by a
 * `:workspaceId` in the URL and a per-integration `webhookSecret`, which
 * these webhooks don't carry: Shopify calls one fixed URL for every shop
 * the app is installed on, signed with the app's own client secret
 * (`SHOPIFY_APP_CLIENT_SECRET`).
 *
 * Store resolution (`IntegrationService.resolveShopHolders`): by Shopify's numeric `shop_id` first, by domain only for
 * legacy rows without an id. A verified delivery teaches a legacy row its id. A shop BRAYN cannot resolve, or a domain
 * that belongs to a different store id, is acknowledged (Shopify requires 2xx) but recorded as an open privacy
 * exception — never as processed — and alerts through the compliance monitor endpoint.
 *
 * Retry contract (Shopify: 2xx = received; anything else is retried 8 times over 4 hours; dedupe by
 * `X-Shopify-Webhook-Id`; 5 s timeout): every verified delivery is claimed in `shopify_compliance_webhooks` first. 2xx
 * only once the work is durably done (`processed`), recorded as an exception, or for a redelivery of either. A failure
 * is recorded (`failed`, error category only) and rethrown so Shopify redelivers. A redelivery while an attempt runs
 * gets 409. Each attempt carries a fencing number: an attempt that was superseded (its claim went stale and was
 * retaken) cannot mark the delivery done, and a data request's records commit only together with that fenced mark —
 * so neither a timeout nor a retry can duplicate them or acknowledge unfinished work. The payload is kept until the
 * delivery is processed or resolved, so a failed one can be replayed (`replay`) after Shopify stops retrying.
 *
 * Never routes a raw request/webhook body, email, phone, or secret
 * through `StructuredLoggerService` — log lines carry only shop
 * domain/topic/counts. Customer identifiers are persisted only in
 * `customer_data_requests` and, transiently, in the delivery's payload.
 */
@Injectable()
export class ShopifyComplianceService {
  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly database: DatabaseService,
    private readonly integrationService: IntegrationService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async handle(topic: string, rawBody: string, headers: Record<string, string>): Promise<void> {
    const clientSecret = this.config.get('SHOPIFY_APP_CLIENT_SECRET', { infer: true });
    if (!clientSecret) {
      throw new ProviderError('Shopify compliance webhooks are not configured.');
    }
    if (!verifyShopifyHmac(rawBody, headers, clientSecret)) {
      throw new UnauthenticatedError('Webhook signature verification failed.');
    }

    let body: ShopifyCompliancePayload;
    try {
      body = JSON.parse(rawBody) as ShopifyCompliancePayload;
    } catch {
      throw new ValidationError('Malformed compliance webhook payload.');
    }

    if (!(SHOPIFY_COMPLIANCE_TOPICS as readonly string[]).includes(topic)) {
      this.logger.event('warn', 'Unrecognized Shopify compliance topic', 'ShopifyComplianceService', { topic });
      return;
    }
    const shopDomain = body?.shop_domain;
    if (!shopDomain) {
      throw new ValidationError('Missing shop_domain in compliance webhook payload.');
    }

    // Shopify's per-delivery dedupe key. If it is ever absent the delivery is still audited, but under a unique key:
    // deduplicating by body could skip a genuine repeat request (e.g. the same customer redacted again after re-import).
    const webhookId = headers['x-shopify-webhook-id'] || `missing:${randomUUID()}`;
    const claim = await this.claim(webhookId, topic, shopDomain, body);
    if (claim === 'done') {
      this.logger.event('log', 'Shopify compliance redelivery of a completed webhook — acknowledged', 'ShopifyComplianceService', { topic, shopDomain });
      return;
    }
    if (claim === 'busy') {
      throw new ConflictError('This compliance delivery is already being processed.');
    }
    await this.run(claim, topic as ShopifyComplianceTopic, body);
  }

  /**
   * Operator recovery (ops script): reprocesses a stored delivery that failed, is an open exception, or whose claim
   * went stale — e.g. after Shopify stopped retrying, or once a store's identity was fixed. Same idempotent path.
   */
  async replay(webhookId: string): Promise<{ status: string }> {
    const t = shopifyComplianceWebhooks;
    const [row] = await this.database.client
      .update(t)
      .set({ status: 'processing', attempts: sql`${t.attempts} + 1`, claimedAt: sql`now()`, error: null })
      .where(
        and(
          eq(t.webhookId, webhookId),
          sql`${t.payload} is not null`,
          or(
            inArray(t.status, ['failed', 'exception']),
            sql`${t.status} = 'processing' and ${t.claimedAt} < now() - ${STALE_CLAIM_INTERVAL}`,
          ),
        ),
      )
      .returning({ attempt: t.attempts, topic: t.topic, payload: t.payload });
    if (!row) {
      throw new NotFoundError(
        'No replayable compliance delivery with that id (unknown, done, running, or its payload was cleared by the 30-day retention).',
      );
    }
    await this.run({ webhookId, attempt: row.attempt }, row.topic as ShopifyComplianceTopic, this.openPayload(row.payload));
    const [after] = await this.database.client.select({ status: t.status }).from(t).where(eq(t.webhookId, webhookId));
    return { status: after?.status ?? 'unknown' };
  }

  /** Operator closes an exception/failed delivery after handling it outside BRAYN; the stored payload is cleared. */
  async resolve(webhookId: string, note: string): Promise<void> {
    const t = shopifyComplianceWebhooks;
    const [row] = await this.database.client
      .update(t)
      .set({ status: 'resolved', resolvedAt: sql`now()`, resolutionNote: note.slice(0, 500), payload: null })
      .where(and(eq(t.webhookId, webhookId), inArray(t.status, ['exception', 'failed'])))
      .returning({ id: t.id });
    if (!row) {
      throw new NotFoundError('No open compliance exception with that id.');
    }
  }

  /** Open privacy work (failed / exception / abandoned) with escalation counts. Counts and a timestamp only. */
  async openIssues() {
    return complianceOpenIssueCounts(this.database.client, new Date());
  }

  /**
   * The stored payload is the verified body encrypted with the app's credential key (AES-256-GCM, the same cipher and
   * key as provider credentials): erasure-request identifiers are never stored in plaintext. Fails closed (non-2xx,
   * Shopify retries) if the key isn't configured.
   */
  private sealPayload(body: ShopifyCompliancePayload): { v: 1; ciphertext: string } {
    return { v: 1, ciphertext: encryptCredential(JSON.stringify(body), this.encryptionKey()) };
  }

  private openPayload(stored: unknown): ShopifyCompliancePayload {
    const sealed = stored as { v?: unknown; ciphertext?: unknown } | null;
    if (sealed?.v !== 1 || typeof sealed.ciphertext !== 'string') {
      throw new ValidationError('Stored compliance payload is not in the encrypted format.');
    }
    return JSON.parse(decryptCredential(sealed.ciphertext, this.encryptionKey())) as ShopifyCompliancePayload;
  }

  private encryptionKey(): Buffer {
    try {
      return parseEncryptionKey(this.config.get('BRAYN_CREDENTIAL_ENCRYPTION_KEY', { infer: true }));
    } catch (error) {
      if (error instanceof InvalidEncryptionKeyError) {
        throw new ProviderError('Credential encryption is not configured.');
      }
      throw error;
    }
  }

  private async run(claim: Claim, topic: ShopifyComplianceTopic, body: ShopifyCompliancePayload): Promise<void> {
    try {
      const shopDomain = String(body.shop_domain);
      const shopId = body.shop_id === undefined || body.shop_id === null ? undefined : String(body.shop_id);
      const { holders, conflicts } = await this.integrationService.resolveShopHolders(shopDomain, shopId);

      let outcome: Outcome;
      if (topic === 'customers/data_request') {
        outcome = holders.length > 0 ? 'recorded' : 'unknown_shop';
      } else if (holders.length === 0) {
        outcome = 'unknown_shop';
      } else if (topic === 'customers/redact') {
        outcome = await this.redactCustomer(holders, body, shopDomain);
      } else {
        for (const holder of holders) {
          await this.integrationService.eraseIntegrationForShopRedact(holder.id);
        }
        this.logger.event('log', 'Shopify shop/redact processed', 'ShopifyComplianceService', { shopDomain, matchedIntegrations: holders.length });
        outcome = 'erased';
      }

      // Legacy rows matched by domain learn their stable id from this verified delivery; a clash is an identity conflict.
      const learned =
        shopId && holders.length > 0
          ? await this.integrationService.recordShopifyShopId(
              holders.filter((h) => !h.shopifyShopId).map((h) => h.id),
              shopId,
            )
          : 'ok';
      const exception: ExceptionReason | null =
        conflicts.length > 0 || learned === 'conflict' ? 'identity_conflict' : holders.length === 0 ? 'unknown_shop' : null;

      const finish = async (client: NodePgDatabase) => {
        if (topic === 'customers/data_request') {
          await this.recordDataRequests(client, holders, body, shopDomain);
        }
        await this.complete(client, claim, outcome, holders.length, exception);
      };
      if (topic === 'customers/data_request') {
        await this.database.transaction(finish);
      } else {
        await finish(this.database.client);
      }

      if (exception) {
        this.logger.event('error', 'Shopify compliance delivery needs operator review (privacy exception)', 'ShopifyComplianceService', {
          webhookId: claim.webhookId,
          topic,
          shopDomain,
          exception,
          matchedIntegrations: holders.length,
          conflictingIntegrations: conflicts.length,
        });
      }
    } catch (error) {
      await this.fail(claim, error);
      throw error;
    }
  }

  /** `claimed` = this attempt owns the delivery; `done` = already completed (processed/exception/resolved); `busy` = running. */
  private async claim(webhookId: string, topic: string, shopDomain: string, body: ShopifyCompliancePayload): Promise<Claim | 'done' | 'busy'> {
    const t = shopifyComplianceWebhooks;
    const [claimed] = await this.database.client
      .insert(t)
      .values({
        webhookId,
        topic,
        shopDomain,
        shopId: body.shop_id === undefined || body.shop_id === null ? null : String(body.shop_id),
        status: 'processing',
        payload: this.sealPayload(body),
      })
      .onConflictDoUpdate({
        target: t.webhookId,
        set: { status: 'processing', attempts: sql`${t.attempts} + 1`, claimedAt: sql`now()`, error: null },
        setWhere: sql`${t.status} = 'failed' or (${t.status} = 'processing' and ${t.claimedAt} < now() - ${STALE_CLAIM_INTERVAL})`,
      })
      .returning({ attempt: t.attempts });
    if (claimed) {
      return { webhookId, attempt: claimed.attempt };
    }
    const [existing] = await this.database.client.select({ status: t.status }).from(t).where(eq(t.webhookId, webhookId)).limit(1);
    return existing && existing.status !== 'processing' && existing.status !== 'failed' ? 'done' : 'busy';
  }

  /**
   * Fenced completion: only the attempt that still owns the claim can finish it. Throws if superseded, which rolls back
   * a data request's records in the same transaction (the newer attempt records them).
   */
  private async complete(client: NodePgDatabase, claim: Claim, outcome: Outcome, matched: number, exception: ExceptionReason | null): Promise<void> {
    const t = shopifyComplianceWebhooks;
    const [row] = await client
      .update(t)
      .set({
        status: exception ? 'exception' : 'processed',
        exceptionReason: exception,
        outcome,
        matchedIntegrations: matched,
        error: null,
        processedAt: sql`now()`,
        // Kept while the exception is open, so it can be replayed once the store's identity is fixed.
        ...(exception ? {} : { payload: null }),
      })
      .where(and(eq(t.webhookId, claim.webhookId), eq(t.attempts, claim.attempt), eq(t.status, 'processing')))
      .returning({ id: t.id });
    if (!row) {
      throw new ConflictError('This compliance attempt was superseded by a newer one.');
    }
  }

  /** Best effort and fenced: recording the failure must never mask the original error, nor overwrite a newer attempt. */
  private async fail(claim: Claim, error: unknown): Promise<void> {
    const category = (error as { code?: unknown })?.code ?? (error instanceof Error ? error.name : 'unknown');
    const t = shopifyComplianceWebhooks;
    try {
      await this.database.client
        .update(t)
        .set({ status: 'failed', error: String(category).slice(0, 64) })
        .where(and(eq(t.webhookId, claim.webhookId), eq(t.attempts, claim.attempt), eq(t.status, 'processing')));
    } catch {
      this.logger.event('error', 'Could not record a failed Shopify compliance webhook', 'ShopifyComplianceService', { webhookId: claim.webhookId });
    }
  }

  /**
   * Persists the request for manual handling (Shopify Protected Customer Data — the merchant must be able to answer a
   * customer's data-access request; not an automated export): one record per workspace that holds the store's data,
   * or one unassigned record for an unresolved shop. The customer identifiers are what a human needs to act.
   */
  private async recordDataRequests(client: NodePgDatabase, holders: Holder[], body: ShopifyCompliancePayload, shopDomain: string): Promise<void> {
    const owners = holders.length > 0 ? holders : [null];
    await client.insert(customerDataRequests).values(
      owners.map((holder) => ({
        workspaceId: holder?.workspaceId ?? null,
        integrationId: holder?.id ?? null,
        provider: 'shopify' as const,
        shopDomain,
        shopifyCustomerId: body.customer?.id !== undefined ? String(body.customer.id) : '',
        customerEmail: body.customer?.email ?? null,
        ordersRequested: body.orders_requested ?? null,
      })),
    );
    this.logger.event('log', 'Shopify customers/data_request recorded for manual handling', 'ShopifyComplianceService', {
      shopDomain,
      resolved: holders.length > 0,
      matchedIntegrations: holders.length,
    });
  }

  /** Erases the customer and the orders Shopify lists, in every workspace that holds the store's data. */
  private async redactCustomer(holders: Holder[], body: ShopifyCompliancePayload, shopDomain: string): Promise<Outcome> {
    const externalId = body.customer?.id !== undefined ? String(body.customer.id) : undefined;
    const orderIds = Array.isArray(body.orders_to_redact) ? body.orders_to_redact.map(String) : [];
    if (externalId === undefined && orderIds.length === 0) {
      return 'nothing_found';
    }

    // Each holder (live, or retained after a disconnect) is erased scoped to its own integration. Sequential: a failure
    // throws (non-2xx) so Shopify redelivers; erasure is idempotent, so holders already done are a no-op on retry.
    let found = 0;
    let canonicalCustomersRemoved = 0;
    let ordersErased = 0;
    for (const holder of holders) {
      const result = await this.integrationService.purgeCommerceCustomer(holder.workspaceId, holder.id, externalId, orderIds);
      found += result.found ? 1 : 0;
      canonicalCustomersRemoved += result.canonicalCustomerRemoved ? 1 : 0;
      ordersErased += result.ordersErased;
    }

    this.logger.event('log', 'Shopify customers/redact processed', 'ShopifyComplianceService', {
      shopDomain,
      matchedIntegrations: holders.length,
      found,
      canonicalCustomersRemoved,
      ordersErased,
    });
    return found > 0 ? 'erased' : 'nothing_found';
  }
}
