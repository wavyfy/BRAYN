import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { AppModule } from '../app.module';
import { DatabaseService } from '../database/database.service';
import { integrations } from '../database/schema/integrations';
import { shopifyComplianceWebhooks } from '../database/schema/shopify-compliance-webhooks';
import { integrationWebhookEvents } from '../database/schema/integration-webhook-events';
import { WebhookIngestService } from '../domains/integration/webhook-ingest.service';
import { IntegrationService } from '../domains/integration/integration.service';
import { ShopifyAdapter } from '../domains/integration/providers/shopify/shopify.adapter';
import { ShopifyComplianceService } from '../domains/integration/providers/shopify/shopify-compliance.service';

/**
 * Operator tool for Shopify compliance identity (doc 30 runbook). Prints ids, statuses and domains only — never a
 * payload, credential or customer identifier. Against production only with explicit approval, via
 * `node --env-file=.env.production dist/scripts/shopify-compliance-ops.js <command>`.
 *
 *   open                                   open privacy issues (failed / exception / abandoned claims)
 *   replay <webhookId>                     reprocess a stored delivery (idempotent)
 *   resolve <webhookId> <note…>            close an exception handled outside BRAYN (clears its payload)
 *   quarantined                            Shopify business webhooks held for a shop that isn't the integration's store
 *   add-shop-alias <ws> <domain> <evidence…>  record a Shopify-verified alias of that workspace's store (evidence required)
 *   release-webhook <webhookEventId>       process one quarantined delivery (after confirming it is this store's)
 *   shop-ids                               Shopify rows without a stable shop id, and whether their token is expired
 *   backfill-shop-id <workspaceId> --apply ONE read-only Admin API call `{ shop { id myshopifyDomain } }`; if the
 *                                          stored token is expired this first REFRESHES it (Shopify rotates the
 *                                          access + refresh token) through the app's normal refresh path
 */
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const db = app.get(DatabaseService).client;
    const compliance = app.get(ShopifyComplianceService);
    const integrationService = app.get(IntegrationService);
    const t = shopifyComplianceWebhooks;

    switch (command) {
      case 'open': {
        const rows = await db
          .select({
            webhookId: t.webhookId,
            topic: t.topic,
            shopDomain: t.shopDomain,
            shopId: t.shopId,
            status: t.status,
            exceptionReason: t.exceptionReason,
            attempts: t.attempts,
            receivedAt: t.receivedAt,
          })
          .from(t)
          .where(
            or(
              inArray(t.status, ['failed', 'exception']),
              sql`${t.status} = 'processing' and ${t.claimedAt} < now() - interval '5 minutes'`,
            ),
          );
        console.table(rows);
        return;
      }
      case 'replay':
        console.log(await compliance.replay(required(args[0], 'webhookId')));
        return;
      case 'resolve':
        await compliance.resolve(
          required(args[0], 'webhookId'),
          required(args.slice(1).join(' '), 'note'),
        );
        console.log('resolved');
        return;
      case 'quarantined': {
        const w = integrationWebhookEvents;
        console.table(
          await db
            .select({
              id: w.id,
              workspaceId: w.workspaceId,
              eventType: w.eventType,
              reason: w.error,
              createdAt: w.createdAt,
            })
            .from(w)
            .where(eq(w.status, 'quarantined')),
        );
        return;
      }
      case 'add-shop-alias': {
        // Evidence (operator text, no secrets) is required and echoed for the change record (doc30).
        const [workspaceId, domain, ...evidence] = args;
        const note = required(evidence.join(' '), 'evidence');
        console.log({ workspaceId, domain, evidence: note });
        console.log({
          updated: await integrationService.addShopDomainAlias(
            required(workspaceId, 'workspaceId'),
            required(domain, 'domain'),
            note,
          ),
        });
        return;
      }
      case 'release-webhook':
        console.log(
          await app
            .get(WebhookIngestService)
            .releaseQuarantined(required(args[0], 'webhookEventId')),
        );
        return;
      case 'shop-ids': {
        const rows = await db
          .select({
            workspaceId: integrations.workspaceId,
            status: integrations.status,
            shopDomain: integrations.shopDomain,
          })
          .from(integrations)
          .where(
            and(
              eq(integrations.provider, 'shopify'),
              isNull(integrations.shopifyShopId),
              ne(integrations.status, 'disconnected'),
            ),
          );
        for (const row of rows) {
          const expiring = await integrationService.isCredentialExpiring(
            row.workspaceId,
            'shopify',
          );
          console.log({ ...row, tokenExpired: expiring, backfillRotatesToken: expiring === true });
        }
        return;
      }
      case 'backfill-shop-id': {
        const workspaceId = required(args[0], 'workspaceId');
        if (!args.includes('--apply')) {
          throw new Error(
            'Refusing without --apply: this calls the Shopify Admin API (see shop-ids for token rotation).',
          );
        }
        const [row] = await db
          .select({
            id: integrations.id,
            shopDomain: integrations.shopDomain,
            shopifyShopId: integrations.shopifyShopId,
          })
          .from(integrations)
          .where(
            and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'shopify')),
          );
        if (!row || row.shopifyShopId) {
          throw new Error(
            row
              ? 'This integration already has a shop id.'
              : 'No Shopify integration in that workspace.',
          );
        }
        const credentials = await integrationService.getCredentials(workspaceId, 'shopify');
        if (!credentials) throw new Error('No stored credentials (disconnected?).');
        const identity = await app.get(ShopifyAdapter).fetchShopIdentity(credentials);
        const result = await integrationService.recordShopifyShopId([row.id], identity.shopId);
        console.log({
          shopId: identity.shopId,
          myshopifyDomain: identity.myshopifyDomain,
          storedDomain: row.shopDomain,
          domainAlias: identity.myshopifyDomain !== row.shopDomain?.toLowerCase(),
          recorded: result,
        });
        return;
      }
      default:
        throw new Error(
          'Usage: open | replay <webhookId> | resolve <webhookId> <note> | shop-ids | backfill-shop-id <workspaceId> --apply',
        );
    }
  } finally {
    await app.close();
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
