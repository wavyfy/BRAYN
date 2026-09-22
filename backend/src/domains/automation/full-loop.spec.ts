import { createHmac, randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { integrations } from '../../database/schema/integrations';
import { integrationWebhookEvents } from '../../database/schema/integration-webhook-events';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { customerHealthStates } from '../../database/schema/customer-health-states';
import { customerHealthStateHistory } from '../../database/schema/customer-health-state-history';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { automationDefinitions } from '../../database/schema/automation-definitions';
import { automationRuns } from '../../database/schema/automation-runs';
import { aiActionRequests } from '../../database/schema/ai-action-requests';
import { idempotencyKeys } from '../../database/schema/idempotency-keys';
import { IntegrationService } from '../integration/integration.service';
import { WebhookIngestService } from '../integration/webhook-ingest.service';
import { AutomationService } from './automation.service';
import { RevenueOpportunityService } from '../intelligence-engines/revenue-opportunity.service';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import { AiActionControlService } from '../ai-action-control/ai-action-control.service';

/**
 * Doc19 Phase 16 — Full BRAYN Integration. Connects and verifies the
 * non-WAPon leg of the system loop with every real domain boundary wired
 * (no mocked service, no stubbed DB): Shopify webhook ingestion → Identity
 * Resolution → UCIR (commerce context) → Revenue Opportunity Detector →
 * `revenue_opportunity.created` → Business Action Automation →
 * `AiActionControlService.executeForAutomation()` → `generate_recommendations`
 * → RecommendationService.
 *
 * Deliberately stops at the automation/action boundary — Communication/
 * Actions (real customer delivery) is doc19 Phase 9 item 2 / WAPon, not
 * built yet, out of scope here.
 *
 * Uses the repo's only supported database — the dev DATABASE_URL from
 * `.env` (no testcontainers/pg-mem exists in this codebase) — through the
 * real `AppModule` graph, exactly as production wires it. `WebhookIngestService.
 * ingest()` and `RevenueOpportunityService.detect()` both emit through the
 * real (fire-and-forget) `EventBus`, so downstream effects are awaited via
 * polling, not assumed synchronous — see `waitFor` below. No Shopify API
 * call is made anywhere in this test: `parseWebhookEvent`/
 * `verifyWebhookSignature` are pure local functions over a synthetic,
 * locally-signed payload.
 *
 * All rows this test writes are scoped to one throwaway workspace, deleted
 * in `afterAll`.
 */
describe('Phase 16 — Commerce → Automation loop (e2e, real DB)', () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let integrationService: IntegrationService;
  let webhookIngestService: WebhookIngestService;
  let automationService: AutomationService;
  let revenueOpportunityService: RevenueOpportunityService;
  let recommendationService: RecommendationService;
  let aiActionControlService: AiActionControlService;

  const workspaceId = randomUUID();
  const webhookSecret = 'full-loop-test-secret';
  const shopDomain = 'brayn-full-loop-test.myshopify.com';
  const customerExternalId = String(Date.now());
  let automationDefinitionId: string;
  let canonicalCustomerId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    // ShopifyAdapter self-registers into ProviderRegistry from onModuleInit() — compile()
    // alone does not run Nest lifecycle hooks, only init() does.
    await moduleRef.init();

    db = moduleRef.get(DatabaseService);
    integrationService = moduleRef.get(IntegrationService);
    webhookIngestService = moduleRef.get(WebhookIngestService);
    automationService = moduleRef.get(AutomationService);
    revenueOpportunityService = moduleRef.get(RevenueOpportunityService);
    recommendationService = moduleRef.get(RecommendationService);
    aiActionControlService = moduleRef.get(AiActionControlService);

    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }

    await db.client.insert(workspaces).values({ id: workspaceId, name: 'Full Loop Test Workspace' });

    await integrationService.connect(workspaceId, 'shopify');
    await integrationService.setCredentials(workspaceId, 'shopify', {
      shopDomain,
      accessToken: 'unused-in-this-test',
      webhookSecret,
    });

    const automation = await automationService.create(workspaceId, { name: 'Full loop test automation' });
    automationDefinitionId = automation.id;
  }, 30_000);

  afterAll(async () => {
    if (!db) return;

    await db.client.delete(recommendations).where(eq(recommendations.workspaceId, workspaceId));
    await db.client.delete(automationRuns).where(eq(automationRuns.workspaceId, workspaceId));
    await db.client.delete(automationDefinitions).where(eq(automationDefinitions.workspaceId, workspaceId));
    await db.client.delete(aiActionRequests).where(eq(aiActionRequests.workspaceId, workspaceId));
    await db.client.delete(revenueOpportunities).where(eq(revenueOpportunities.workspaceId, workspaceId));
    await db.client.delete(commerceOrders).where(eq(commerceOrders.workspaceId, workspaceId));
    await db.client.delete(commerceCustomers).where(eq(commerceCustomers.workspaceId, workspaceId));
    // `order.created` (this test's webhook-delivered order) now triggers CustomerHealthService.recalculate()
    // automatically — these rows reference canonicalCustomers and must be deleted before it.
    await db.client.delete(customerHealthStateHistory).where(eq(customerHealthStateHistory.workspaceId, workspaceId));
    await db.client.delete(customerHealthStates).where(eq(customerHealthStates.workspaceId, workspaceId));
    await db.client.delete(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, workspaceId));
    await db.client.delete(integrationWebhookEvents).where(eq(integrationWebhookEvents.workspaceId, workspaceId));
    await db.client.delete(integrations).where(eq(integrations.workspaceId, workspaceId));
    await db.client.delete(workspaces).where(eq(workspaces.id, workspaceId));
    // Idempotency keys embed workspaceId/integrationId in their string — no dedicated FK to filter on,
    // so this is a best-effort sweep of every key this run could plausibly have reserved.
    await db.client.delete(idempotencyKeys).where(like(idempotencyKeys.key, `%${workspaceId}%`));

    await moduleRef.close();
  }, 30_000);

  it(
    'propagates a Shopify order through Identity Resolution, UCIR, Revenue Opportunity Detection, Automation, AI Action Control, and Recommendations',
    async () => {
      // 1. Shopify webhook ingestion — customers/create. Signature verified for real against
      // the credential stored above; no mocked boundary.
      const customerBody = JSON.stringify({
        id: Number(customerExternalId),
        email: `full-loop-${customerExternalId}@example.com`,
        first_name: 'Full',
        last_name: 'Loop',
        phone: null,
        updated_at: new Date().toISOString(),
      });
      await webhookIngestService.ingest(workspaceId, 'shopify', customerBody, {
        'x-shopify-topic': 'customers/create',
        'x-shopify-hmac-sha256': sign(customerBody, webhookSecret),
      });

      // Identity Resolution runs off the fire-and-forget EventBus — poll for it rather than
      // assuming synchronous completion (EventBus.emit() does not await async listeners).
      const commerceCustomerRow = await waitFor(async () => {
        const [row] = await db.client
          .select()
          .from(commerceCustomers)
          .where(and(eq(commerceCustomers.workspaceId, workspaceId), eq(commerceCustomers.externalId, customerExternalId)))
          .limit(1);
        return row?.canonicalCustomerId ? row : undefined;
      }, 'customer webhook to resolve to a canonical customer');
      canonicalCustomerId = commerceCustomerRow.canonicalCustomerId!;

      // 2. Shopify webhook ingestion — orders/create, dated past the win-back threshold (120
      // days) so RevenueOpportunityService.detect() has a real signal to find.
      const orderExternalId = `${Date.now()}`;
      const orderUpdatedAt = new Date(Date.now() - 130 * 24 * 60 * 60 * 1000).toISOString();
      const orderBody = JSON.stringify({
        id: Number(orderExternalId),
        customer: { id: Number(customerExternalId) },
        total_price: '250.00',
        updated_at: orderUpdatedAt,
        line_items: [],
        refunds: [],
        fulfillments: [],
      });
      await webhookIngestService.ingest(workspaceId, 'shopify', orderBody, {
        'x-shopify-topic': 'orders/create',
        'x-shopify-hmac-sha256': sign(orderBody, webhookSecret),
      });

      await waitFor(async () => {
        const [row] = await db.client
          .select()
          .from(commerceOrders)
          .where(and(eq(commerceOrders.workspaceId, workspaceId), eq(commerceOrders.externalId, orderExternalId)))
          .limit(1);
        return row?.customerId ? row : undefined;
      }, 'order webhook to link to the resolved customer');

      // 3. Revenue Opportunity Detector — real UCIR read, real detection math, real
      // `revenue_opportunity.created` emit (fire-and-forget, same as above).
      const opportunities = await revenueOpportunityService.detect(workspaceId, canonicalCustomerId);
      const winBack = opportunities.find((o) => o.type === 'win_back');
      expect(winBack, 'RevenueOpportunityService.detect() should have created a win_back opportunity').toBeDefined();

      // 4. Business Action Automation picks up the event, routes through AI Action Control's
      // executeForAutomation() (real enforcement point, real idempotency, real audit), which
      // runs the real `generate_recommendations` action.
      const succeededRun = await waitFor(async () => {
        const runs = await automationService.listRuns(workspaceId, automationDefinitionId);
        return runs.find((r) => r.canonicalCustomerId === canonicalCustomerId && r.status !== 'skipped');
      }, 'automation run to complete for this opportunity');

      expect(succeededRun.status, `automation run should succeed, got: ${JSON.stringify(succeededRun)}`).toBe('succeeded');
      expect((succeededRun.result as { recommendationsCount?: number } | null)?.recommendationsCount).toBeGreaterThanOrEqual(1);

      // 5. Recommendation actually exists (the loop's real, observable end state).
      const activeRecommendations = await recommendationService.list(workspaceId, canonicalCustomerId);
      const recommendationForOpportunity = activeRecommendations.find((r) => r.sourceOpportunityId === winBack!.id);
      expect(recommendationForOpportunity, 'a recommendation sourced from the win_back opportunity should exist').toBeDefined();
      expect(recommendationForOpportunity!.text).toBe('Send a win-back offer to re-engage this customer.');

      // 6. AI Action Control's own audit trail reflects a system-initiated, auto-executed action
      // (doc19 Phase 15 item 7 — nullable actor fields) — the same visible result Phase 14 promises.
      const recentActions = await aiActionControlService.listRecent(workspaceId);
      const auditRow = recentActions.find((a) => a.action === 'generate_recommendations' && a.customerId === canonicalCustomerId);
      expect(auditRow, 'AI Action Control should have an audit row for the automation-triggered action').toBeDefined();
      expect(auditRow!.executionStatus).toBe('executed');
      expect(auditRow!.approvalState).toBe('not_required');
      expect(auditRow!.actorUserId).toBeNull();
      expect(auditRow!.actorRole).toBeNull();
    },
    30_000,
  );
});

function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

/** Polls a fire-and-forget-triggered read until it resolves to a truthy value, or fails with a clear message. */
async function waitFor<T>(read: () => Promise<T | undefined>, description: string, timeoutMs = 10_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await read();
    if (result !== undefined) {
      return result;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
