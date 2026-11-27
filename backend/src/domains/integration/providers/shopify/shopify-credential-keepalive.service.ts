import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm';
import { DatabaseService } from '../../../../database/database.service';
import { integrations } from '../../../../database/schema/integrations';
import { ConflictError, CredentialRevokedError } from '../../../../common/errors/app-error';
import { StructuredLoggerService } from '../../../../common/logging/structured-logger.service';
import { captureException } from '../../../../common/observability/sentry';
import {
  CREDENTIAL_REAUTHORIZATION_REQUIRED,
  IntegrationService,
  isAccessTokenExpiring,
} from '../../integration.service';
import { ShopifyAdapter } from './shopify.adapter';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Renew a refresh token this long before it lapses (Shopify: 90-day lifetime); leaves ~30 daily retries on failure. */
export const SHOPIFY_REFRESH_RENEW_WITHIN_DAYS = 30;
const ALIAS_EVIDENCE =
  "Shopify Admin API shop.myshopifyDomain returned for this store's own access token (credential keep-alive)";

/** Whether a credential's refresh-token lineage needs renewing: it has a refresh token whose expiry is unknown or near. */
export function isRefreshTokenDue(credentials: Record<string, string>, renewBefore: Date): boolean {
  if (!credentials.refreshToken) return false;
  const expiry = credentials.refreshTokenExpiresAt
    ? new Date(credentials.refreshTokenExpiresAt).getTime()
    : NaN;
  return Number.isNaN(expiry) || expiry < renewBefore.getTime();
}

export interface ShopifyKeepAliveCounts {
  due: number;
  renewed: number;
  shopIdsRecorded: number;
  aliasesRecorded: number;
  identityConflicts: number;
  reauthorizationRequired: number;
  failed: number;
}

/**
 * Shopify credential keep-alive (runs inside the daily intelligence run, i.e. inside the production runtime that holds
 * the credential key — the key never leaves it). For each live Shopify connection that needs it:
 * 1. renews the refresh token when its expiry is unknown or within {@link SHOPIFY_REFRESH_RENEW_WITHIN_DAYS} days
 *    (one refresh via `IntegrationService.renewCredentials`: per-integration lock across backends, failure never
 *    overwrites the credential or disconnects the store);
 * 2. when the row has no stable shop id, reads `shop { id myshopifyDomain }` with the store's own token and records
 *    the id (never overwriting one; a live duplicate is a conflict, not a write) and Shopify's myshopify domain as a
 *    verified alias (collision-checked against every other workspace).
 * A connection whose refresh token Shopify refused (401, final) is skipped — no further calls until it reconnects.
 * Anything else is untouched: no Shopify call, no rotation.
 */
@Injectable()
export class ShopifyCredentialKeepAliveService {
  constructor(
    private readonly database: DatabaseService,
    private readonly integrationService: IntegrationService,
    private readonly shopifyAdapter: ShopifyAdapter,
    private readonly logger: StructuredLoggerService,
  ) {}

  /** `scope.workspaceIds` limits the run to those workspaces (tests on a shared database); production runs all. */
  async run(
    now = new Date(),
    scope: { workspaceIds?: string[] } = {},
  ): Promise<ShopifyKeepAliveCounts> {
    const renewBefore = new Date(now.getTime() + SHOPIFY_REFRESH_RENEW_WITHIN_DAYS * DAY_MS);
    const rows = await this.database.client
      .select({
        id: integrations.id,
        workspaceId: integrations.workspaceId,
        shopDomain: integrations.shopDomain,
        shopifyShopId: integrations.shopifyShopId,
        renewalError: integrations.credentialRenewalError,
      })
      .from(integrations)
      .where(
        and(
          eq(integrations.provider, 'shopify'),
          ne(integrations.status, 'disconnected'),
          isNotNull(integrations.credentials),
          scope.workspaceIds ? inArray(integrations.workspaceId, scope.workspaceIds) : undefined,
          or(
            isNull(integrations.shopifyShopId),
            isNull(integrations.credentialRefreshExpiresAt),
            lt(integrations.credentialRefreshExpiresAt, renewBefore),
          ),
        ),
      );

    const counts: ShopifyKeepAliveCounts = {
      due: rows.length,
      renewed: 0,
      shopIdsRecorded: 0,
      aliasesRecorded: 0,
      identityConflicts: 0,
      reauthorizationRequired: 0,
      failed: 0,
    };
    for (const row of rows) {
      const ctx = { workspaceId: row.workspaceId, integrationId: row.id };
      if (row.renewalError === CREDENTIAL_REAUTHORIZATION_REQUIRED) {
        counts.reauthorizationRequired++;
        continue;
      }
      try {
        const needsIdentity = !row.shopifyShopId;
        let refreshing = false;
        // Refresh only for the lineage, or for a usable token when the shop id must be read — never otherwise.
        const credentials = await this.integrationService.renewCredentials(
          row.workspaceId,
          'shopify',
          (current) => {
            refreshing =
              isRefreshTokenDue(current, renewBefore) ||
              (needsIdentity && isAccessTokenExpiring(current, now.getTime()));
            return refreshing;
          },
        );
        if (refreshing) counts.renewed++;
        if (!needsIdentity || !credentials) continue;

        const identity = await this.shopifyAdapter.fetchShopIdentity(credentials);
        if (
          (await this.integrationService.recordShopifyShopId([row.id], identity.shopId)) ===
          'conflict'
        ) {
          counts.identityConflicts++;
          this.logger.event(
            'error',
            'Shopify shop id already belongs to another live connection',
            'ShopifyCredentialKeepAlive',
            ctx,
          );
          continue;
        }
        counts.shopIdsRecorded++;
        if (row.shopDomain && identity.myshopifyDomain !== row.shopDomain.toLowerCase()) {
          try {
            if (
              await this.integrationService.addShopDomainAlias(
                row.workspaceId,
                identity.myshopifyDomain,
                ALIAS_EVIDENCE,
              )
            ) {
              counts.aliasesRecorded++;
              this.logger.event(
                'warn',
                "Shopify store alias recorded from the store's own token",
                'ShopifyCredentialKeepAlive',
                {
                  ...ctx,
                  domain: identity.myshopifyDomain,
                },
              );
            }
          } catch (error) {
            if (!(error instanceof ConflictError)) throw error;
            counts.identityConflicts++;
            this.logger.event(
              'error',
              'Shopify alias not recorded: another workspace has that domain',
              'ShopifyCredentialKeepAlive',
              ctx,
            );
          }
        }
      } catch (error) {
        if (error instanceof CredentialRevokedError) counts.reauthorizationRequired++;
        else counts.failed++;
        this.logger.event(
          'error',
          'Shopify credential keep-alive failed',
          'ShopifyCredentialKeepAlive',
          {
            ...ctx,
            reauthorizationRequired: error instanceof CredentialRevokedError,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        captureException(error);
      }
    }
    const problem = counts.failed + counts.reauthorizationRequired + counts.identityConflicts > 0;
    this.logger.event(
      problem ? 'error' : 'log',
      'Shopify credential keep-alive completed',
      'ShopifyCredentialKeepAlive',
      { ...counts },
    );
    return counts;
  }
}
