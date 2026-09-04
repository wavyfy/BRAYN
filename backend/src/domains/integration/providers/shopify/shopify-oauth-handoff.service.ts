import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service';
import { shopifyOauthHandoffTokens } from '../../../../database/schema/shopify-oauth-handoff-tokens';

const HANDOFF_TOKEN_TTL_MS = 60 * 1000;

export interface MintedHandoffToken {
  token: string;
  expiresAt: Date;
}

export interface ConsumedHandoffToken {
  clerkUserId: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mint/consume for the opaque, single-use token that stands in for the
 * Clerk bearer token on the Shopify OAuth `/start` top-level navigation
 * (doc 20 Part 4B). Only the token's SHA-256 hash is ever persisted; the
 * raw token exists only in memory here and in the mint response body —
 * never logged (http-logging.hook.ts only logs method/path/status).
 */
@Injectable()
export class ShopifyOAuthHandoffService {
  constructor(private readonly database: DatabaseService) {}

  async mint(clerkUserId: string, workspaceId: string): Promise<MintedHandoffToken> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + HANDOFF_TOKEN_TTL_MS);

    await this.database.client.insert(shopifyOauthHandoffTokens).values({
      tokenHash: hashToken(token),
      clerkUserId,
      workspaceId,
      expiresAt,
    });

    return { token, expiresAt };
  }

  /**
   * Atomically claims the token. The conditional UPDATE — unconsumed,
   * unexpired, matching workspace — is what makes this single-use and
   * race-safe: a concurrent second consume of the same token loses the
   * `consumedAt IS NULL` race (Postgres row-level locking) and gets zero
   * rows back, same as an expired or already-consumed token.
   */
  async consume(token: string, workspaceId: string): Promise<ConsumedHandoffToken | null> {
    const [claimed] = await this.database.client
      .update(shopifyOauthHandoffTokens)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(shopifyOauthHandoffTokens.tokenHash, hashToken(token)),
          eq(shopifyOauthHandoffTokens.workspaceId, workspaceId),
          isNull(shopifyOauthHandoffTokens.consumedAt),
          gt(shopifyOauthHandoffTokens.expiresAt, new Date()),
        ),
      )
      .returning({ clerkUserId: shopifyOauthHandoffTokens.clerkUserId });

    return claimed ?? null;
  }
}
