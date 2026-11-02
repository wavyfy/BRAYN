import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray, like } from 'drizzle-orm';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { integrations } from '../../database/schema/integrations';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { internalNotifications } from '../../database/schema/internal-notifications';
import { automationDefinitions } from '../../database/schema/automation-definitions';
import { automationRuns } from '../../database/schema/automation-runs';
import { aiActionRequests } from '../../database/schema/ai-action-requests';
import { idempotencyKeys } from '../../database/schema/idempotency-keys';
import { ValidationError } from '../../common/errors/app-error';
import { createEvent } from '../../common/events/domain-event';
import type { RevenueOpportunityCreatedPayload } from '../intelligence-engines/revenue-opportunity.service';
import { InternalNotificationService } from '../intelligence-engines/internal-notification.service';
import { IntegrationService } from '../integration/integration.service';
import { AutomationService, DUPLICATE_TRIGGER_REASON } from './automation.service';

/**
 * Real-DB check of `internal_notification.create` through the real wiring (AutomationService → AiActionControlService →
 * InternalNotificationService): one notification per opportunity across automations, replay → skipped, no opportunity
 * status change, read-time content, tenant isolation, and deletion during customer erasure.
 */
describe('Automation internal notification (real DB)', { timeout: 120_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let automations: AutomationService;
  let notifications: InternalNotificationService;
  let integrationService: IntegrationService;
  const wsA = randomUUID();
  const wsB = randomUUID();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    automations = moduleRef.get(AutomationService);
    notifications = moduleRef.get(InternalNotificationService);
    integrationService = moduleRef.get(IntegrationService);
    await db.client.insert(workspaces).values([
      { id: wsA, name: 'Automation Internal Notification Test A' },
      { id: wsB, name: 'Automation Internal Notification Test B' },
    ]);
  }, 90_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [wsA, wsB];
    for (const ws of ids) await db.client.delete(idempotencyKeys).where(like(idempotencyKeys.key, `ai-action-automation:${ws}:%`));
    await db.client.delete(automationRuns).where(inArray(automationRuns.workspaceId, ids));
    await db.client.delete(automationDefinitions).where(inArray(automationDefinitions.workspaceId, ids));
    await db.client.delete(aiActionRequests).where(inArray(aiActionRequests.workspaceId, ids));
    await db.client.delete(internalNotifications).where(inArray(internalNotifications.workspaceId, ids));
    await db.client.delete(revenueOpportunities).where(inArray(revenueOpportunities.workspaceId, ids));
    await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
    await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
    await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    await moduleRef?.close();
  }, 90_000);

  async function seedOpportunity(workspaceId: string) {
    const [customer] = await db.client.insert(canonicalCustomers).values({ workspaceId, primaryEmail: `${randomUUID()}@example.com` }).returning();
    const [opportunity] = await db.client
      .insert(revenueOpportunities)
      .values({ workspaceId, canonicalCustomerId: customer.id, type: 'win_back', priority: 'critical', confidence: 70, reason: 'No order in 150 days', recommendedAction: 'a' })
      .returning();
    const event = createEvent<RevenueOpportunityCreatedPayload>({
      type: 'revenue_opportunity.created',
      workspaceId,
      entityId: opportunity.id,
      payload: { opportunityId: opportunity.id, canonicalCustomerId: customer.id, type: 'win_back', priority: 'critical', estimatedRevenue: null, confidence: 70 },
    });
    return { customer, opportunity, event };
  }

  it('creates one notification per opportunity across automations; a replay is skipped; opportunity status is unchanged', async () => {
    const { customer, opportunity, event } = await seedOpportunity(wsA);
    const first = await automations.create(wsA, { name: 'notify 1', triggerType: 'revenue_opportunity.created', actionType: 'internal_notification.create' });
    const second = await automations.create(wsA, { name: 'notify 2', actionType: 'internal_notification.create', conditions: { typeIn: ['win_back'] } });
    const otherWorkspace = await automations.create(wsB, { name: 'B notify', actionType: 'internal_notification.create' });
    expect(first.actionType).toBe('internal_notification.create');

    await automations.handleRevenueOpportunityCreated(event);
    const rows = await db.client.select().from(internalNotifications).where(eq(internalNotifications.workspaceId, wsA));
    expect(rows).toEqual([expect.objectContaining({ opportunityId: opportunity.id, canonicalCustomerId: customer.id })]);
    const runs = await db.client.select().from(automationRuns).where(eq(automationRuns.workspaceId, wsA));
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.automationId).sort()).toEqual([first.id, second.id].sort());
    for (const run of runs) expect(run).toMatchObject({ status: 'succeeded', result: { notificationId: rows[0].id } });
    const audits = await db.client.select().from(aiActionRequests).where(eq(aiActionRequests.workspaceId, wsA));
    expect(audits.map((a) => [a.action, a.executionStatus, a.approvalState])).toEqual([
      ['internal_notification.create', 'executed', 'not_required'],
      ['internal_notification.create', 'executed', 'not_required'],
    ]);

    await automations.handleRevenueOpportunityCreated(event);
    const replayRuns = await db.client.select().from(automationRuns).where(eq(automationRuns.workspaceId, wsA)).orderBy(automationRuns.createdAt);
    expect(replayRuns).toHaveLength(4);
    expect(replayRuns.slice(2).map((r) => [r.status, r.reason])).toEqual([
      ['skipped', DUPLICATE_TRIGGER_REASON],
      ['skipped', DUPLICATE_TRIGGER_REASON],
    ]);
    expect(await db.client.select().from(internalNotifications).where(eq(internalNotifications.workspaceId, wsA))).toHaveLength(1);

    const [after] = await db.client.select().from(revenueOpportunities).where(eq(revenueOpportunities.id, opportunity.id));
    expect(after.status).toBe(opportunity.status);

    // Tenant isolation: workspace B's automation never saw workspace A's event, and B sees no notifications.
    expect(await db.client.select().from(automationRuns).where(eq(automationRuns.automationId, otherWorkspace.id))).toHaveLength(0);
    expect(await notifications.list(wsB)).toEqual({ items: [], total: 0 });

    // Read-time content comes from the opportunity.
    expect(await notifications.list(wsA)).toEqual({
      items: [
        expect.objectContaining({
          id: rows[0].id,
          opportunityId: opportunity.id,
          canonicalCustomerId: customer.id,
          type: 'win_back',
          priority: 'critical',
          reason: 'No order in 150 days',
        }),
      ],
      total: 1,
    });
  });

  it('rejects the customer_health.recalculated trigger for internal_notification.create', async () => {
    await expect(automations.create(wsA, { name: 'bad', triggerType: 'customer_health.recalculated', actionType: 'internal_notification.create' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('refuses an opportunity from another workspace and records a failed run without a notification', async () => {
    const { event } = await seedOpportunity(wsB);
    const automation = await automations.create(wsA, { name: 'cross-tenant', actionType: 'internal_notification.create' });
    await automations.handleRevenueOpportunityCreated({ ...event, workspaceId: wsA });
    const [run] = await db.client.select().from(automationRuns).where(eq(automationRuns.automationId, automation.id));
    expect(run.status).toBe('failed');
    expect(await db.client.select().from(internalNotifications).where(eq(internalNotifications.opportunityId, event.payload.opportunityId))).toHaveLength(0);
  });

  it('caps the list at the requested limit and still reports the total', async () => {
    const before = await notifications.list(wsA);
    for (let i = 0; i < 2; i++) {
      const { customer, opportunity } = await seedOpportunity(wsA);
      await notifications.createForOpportunity(wsA, customer.id, opportunity.id);
    }
    const page = await notifications.list(wsA, 1);
    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(before.total + 2);
  });

  it('deletes the customer’s notifications during customer erasure', async () => {
    const [integration] = await db.client.insert(integrations).values({ workspaceId: wsA, provider: 'shopify' }).returning();
    const { customer, opportunity } = await seedOpportunity(wsA);
    await db.client.insert(commerceCustomers).values({ workspaceId: wsA, integrationId: integration.id, provider: 'shopify', externalId: 'erase-1', canonicalCustomerId: customer.id });
    await notifications.createForOpportunity(wsA, customer.id, opportunity.id);

    const result = await integrationService.purgeCommerceCustomer(wsA, integration.id, 'erase-1');
    expect(result).toEqual({ found: true, canonicalCustomerRemoved: true });
    expect(await db.client.select().from(internalNotifications).where(eq(internalNotifications.canonicalCustomerId, customer.id))).toHaveLength(0);
  });
});
