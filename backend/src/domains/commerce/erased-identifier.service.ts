import { createHmac } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Env } from '../../config/env.schema';
import { ServiceUnavailableError } from '../../common/errors/app-error';
import { erasedCustomerIdentifiers, type ErasedIdentifierKind } from '../../database/schema/erased-customer-identifiers';

/** One identifier of an erased customer, before hashing. `value` is already normalized (see the builders below). */
export interface ErasedIdentifier {
  kind: ErasedIdentifierKind;
  value: string;
}

const HMAC_CONTEXT = 'brayn-erasure-v1';
const SEP = '\u0000';

/** Trimmed, lower-cased — the same normalization identity resolution matches on. Null for an empty value. */
export function emailIdentifier(email: string | null | undefined): ErasedIdentifier | null {
  const value = email?.trim().toLowerCase();
  return value ? { kind: 'email', value } : null;
}

export function sourceIdentifier(provider: string, externalId: string): ErasedIdentifier {
  return { kind: 'source', value: `${provider}${SEP}${externalId}` };
}

export function orderIdentifier(provider: string, externalId: string): ErasedIdentifier {
  return { kind: 'order', value: `${provider}${SEP}${externalId}` };
}

const keyOf = (identifier: ErasedIdentifier) => `${identifier.kind}${SEP}${identifier.value}`;

/**
 * The block list of erased customers' identifiers (`erased_customer_identifiers`) and the per-workspace erasure
 * lock that keeps it race-free.
 *
 * Locking: one transaction-scoped advisory lock per workspace. Person-level erasure takes it exclusively; every
 * write that could recreate customer data (customer upserts, guest upserts, order upserts) takes it shared, in the
 * same transaction as its `findBlocked` check. So an erasure waits for in-flight writes to commit (and then deletes
 * what they wrote), and any write after it sees the new block-list rows. Both sides take this lock first, before
 * any row lock, so lock order is consistent.
 *
 * Fail closed: identifiers can only be hashed with `ERASURE_HMAC_SECRET`. If a workspace has block-list rows but the
 * secret is missing, or the rows were written under a different secret (`keyId`), `findBlocked` throws instead of
 * letting an erased person back in — the write retries / dead-letters until the configuration is fixed.
 */
@Injectable()
export class ErasedIdentifierService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async lockShared(tx: NodePgDatabase, workspaceId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${`customer-erasure:${workspaceId}`}, 0))`);
  }

  async lockExclusive(tx: NodePgDatabase, workspaceId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`customer-erasure:${workspaceId}`}, 0))`);
  }

  /** Throws 503 when erasure can't run here (no secret) — checked before an erasure touches anything. */
  requireConfigured(): void {
    this.requireSecret();
  }

  /** Adds identifiers to the block list (idempotent). Returns how many distinct identifiers were given. */
  async record(tx: NodePgDatabase, workspaceId: string, identifiers: ErasedIdentifier[]): Promise<number> {
    const secret = this.requireSecret();
    const unique = [...new Map(identifiers.map((identifier) => [keyOf(identifier), identifier])).values()];
    if (unique.length === 0) {
      return 0;
    }
    const keyId = fingerprint(secret);
    await tx
      .insert(erasedCustomerIdentifiers)
      .values(unique.map((identifier) => ({ workspaceId, kind: identifier.kind, valueHmac: hmac(secret, workspaceId, identifier), keyId })))
      .onConflictDoNothing();
    return unique.length;
  }

  /**
   * Which of `identifiers` are blocked in this workspace, as a predicate. Call inside the writing transaction, after
   * `lockShared`. Costs one indexed query for a workspace with nothing erased (the common case) — no hashing.
   */
  async findBlocked(tx: NodePgDatabase, workspaceId: string, identifiers: Array<ErasedIdentifier | null>): Promise<(identifier: ErasedIdentifier | null) => boolean> {
    const present = identifiers.filter((identifier): identifier is ErasedIdentifier => identifier !== null);
    if (present.length === 0) {
      return () => false;
    }
    const keyIds = await tx
      .selectDistinct({ keyId: erasedCustomerIdentifiers.keyId })
      .from(erasedCustomerIdentifiers)
      .where(eq(erasedCustomerIdentifiers.workspaceId, workspaceId));
    if (keyIds.length === 0) {
      return () => false;
    }
    const secret = this.config.get('ERASURE_HMAC_SECRET', { infer: true });
    if (!secret) {
      throw new Error('This workspace has erased customers but ERASURE_HMAC_SECRET is not configured — refusing to write customer data.');
    }
    const keyId = fingerprint(secret);
    if (keyIds.some((row) => row.keyId !== keyId)) {
      throw new Error('Erased-customer identifiers were written under a different ERASURE_HMAC_SECRET — refusing to write customer data.');
    }

    const hashByKey = new Map(present.map((identifier) => [keyOf(identifier), hmac(secret, workspaceId, identifier)]));
    const rows = await tx
      .select({ valueHmac: erasedCustomerIdentifiers.valueHmac })
      .from(erasedCustomerIdentifiers)
      .where(and(eq(erasedCustomerIdentifiers.workspaceId, workspaceId), inArray(erasedCustomerIdentifiers.valueHmac, [...new Set(hashByKey.values())])));
    const blocked = new Set(rows.map((row) => row.valueHmac));
    return (identifier) => identifier !== null && blocked.has(hashByKey.get(keyOf(identifier)) ?? hmac(secret, workspaceId, identifier));
  }

  private requireSecret(): string {
    const secret = this.config.get('ERASURE_HMAC_SECRET', { infer: true });
    if (!secret) {
      throw new ServiceUnavailableError('Customer erasure is not configured on this deployment.');
    }
    return secret;
  }
}

/** Workspace, kind and value are all in the message: equal values in different workspaces or kinds never collide. */
function hmac(secret: string, workspaceId: string, identifier: ErasedIdentifier): string {
  return createHmac('sha256', secret).update([HMAC_CONTEXT, workspaceId, identifier.kind, identifier.value].join(SEP)).digest('hex');
}

function fingerprint(secret: string): string {
  return createHmac('sha256', secret).update(`${HMAC_CONTEXT}${SEP}key-id`).digest('hex').slice(0, 16);
}
