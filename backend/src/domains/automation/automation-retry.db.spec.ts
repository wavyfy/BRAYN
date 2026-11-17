import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray, like } from 'drizzle-orm';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { internalNotifications } from '../../database/schema/internal-notifications';
import { automationDefinitions } from '../../database/schema/automation-definitions';
import { automationRuns } from '../../database/schema/automation-runs';
import { aiActionRequests } from '../../database/schema/ai-action-requests';
import { idempotencyKeys } from '../../database/schema/idempotency-keys';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import { createEvent } from '../../common/events/domain-event';
import type { RevenueOpportunityCreatedPayload } from '../intelligence-engines/revenue-opportunity.service';
import { InternalNotificationService } from '../intelligence-engines/internal-notification.service';
import { RecommendationService } from '../intelligence-engines/recommendation.service';
import { AutomationService } from './automation.service';

/**
 * Real-DB check of manual retry (doc16 decision, Nov 2, 2026) through the real wiring: a genuine (transient) failure of a
 * retry-safe action releases its key, a replay or retry executes again under the same key with exactly one business
 * effect, history is append-only, and refusals execute nothing.
 */
describe('Automation manual retry (real DB)', { timeout: 180_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let automations: AutomationService;
  let notificationService: InternalNotificationService;
  let recommendationService: RecommendationService;
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
    notificationService = moduleRef.get(InternalNotificationService);
    recommendationService = moduleRef.get(RecommendationService);
    await db.client.insert(workspaces).values([
      { id: wsA, name: 'Automation Retry Test A' },
      { id: wsB, name: 'Automation Retry Test B' },
    ]);
  }, 90_000);

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [wsA, wsB];
    for (const ws of ids) await db.client.delete(idempotencyKeys).where(like(idempotencyKeys.key, `ai-action-automation:${ws}:%`));
    // Retries reference earlier runs: delete the retries first.
    await db.client.delete(automationRuns).where(and(inArray(automationRuns.workspaceId, ids), eq(automationRuns.status, 'succeeded')));
    await db.client.update(automationRuns).set({ retryOfRunId: null }).where(inArray(automationRuns.workspaceId, ids));
    await db.client.delete(automationRuns).where(inArray(automationRuns.workspaceId, ids));
    await db.client.delete(automationDefinitions).where(inArray(automationDefinitions.workspaceId, ids));
    await db.client.delete(aiActionRequests).where(inArray(aiActionRequests.workspaceId, ids));
    await db.client.delete(internalNotifications).where(inArray(internalNotifications.workspaceId, ids));
    await db.client.delete(recommendations).where(inArray(recommendations.workspaceId, ids));
    await db.client.delete(revenueOpportunities).where(inArray(revenueOpportunities.workspaceId, ids));
    await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    await moduleRef?.close();
  }, 90_000);

  async function seed(actionType: 'internal_notification.create' | 'generate_recommendations') {
    const [customer] = await db.client.insert(canonicalCustomers).values({ workspaceId: wsA, primaryEmail: `${randomUUID()}@example.com` }).returning();
    const [opportunity] = await db.client
      .insert(revenueOpportunities)
      .values({ workspaceId: wsA, canonicalCustomerId: customer.id, type: 'reorder', priority: 'high', confidence: 80, reason: 'r', recommendedAction: 'a' })
      .returning();
    // Only this test's automation may react to its event (earlier tests' automations stay in the workspace).
    await db.client.update(automationDefinitions).set({ enabled: false }).where(eq(automationDefinitions.workspaceId, wsA));
    const automation = await automations.create(wsA, { name: `retry ${actionType}`, actionType });
    const event = createEvent<RevenueOpportunityCreatedPayload>({
      type: 'revenue_opportunity.created',
      workspaceId: wsA,
      entityId: opportunity.id,
      payload: { opportunityId: opportunity.id, canonicalCustomerId: customer.id, type: 'reorder', priority: 'high', estimatedRevenue: null, confidence: 80 },
    });
    const key = `ai-action-automation:${wsA}:${actionType}:${automation.id}:${event.id}`;
    return { customer, opportunity, automation, event, key };
  }
  const runsOf = (automationId: string) => db.client.select().from(automationRuns).where(eq(automationRuns.automationId, automationId)).orderBy(automationRuns.createdAt);
  const keyStatus = async (key: string) => (await db.client.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key)))[0]?.status;
  const notificationsFor = (opportunityId: string) => db.client.select().from(internalNotifications).where(eq(internalNotifications.opportunityId, opportunityId));
  async function failOnce(event: Parameters<AutomationService['handleRevenueOpportunityCreated']>[0]) {
    vi.spyOn(notificationService, 'createForOpportunity').mockRejectedValueOnce(new Error('connection reset'));
    await automations.handleRevenueOpportunityCreated(event);
  }

  it('a transient failure is a retryable failed run with its input and a released key; a replay executes (not a duplicate)', async () => {
    const { opportunity, automation, event, key } = await seed('internal_notification.create');

    await failOnce(event);
    const [failed] = await runsOf(automation.id);
    expect(failed).toMatchObject({ status: 'failed', reason: 'connection reset', result: { retryable: true }, actionInput: { opportunityId: opportunity.id } });
    expect(await keyStatus(key)).toBe('failed');
    expect(await notificationsFor(opportunity.id)).toHaveLength(0);

    await automations.handleRevenueOpportunityCreated(event);
    const runs = await runsOf(automation.id);
    expect(runs.map((r) => r.status)).toEqual(['failed', 'succeeded']);
    expect(await notificationsFor(opportunity.id)).toHaveLength(1);
    expect(await keyStatus(key)).toBe('completed');

    // The trigger has since succeeded: retrying the old failed run executes nothing and records nothing.
    await expect(automations.retryRun(wsA, automation.id, failed.id)).rejects.toBeInstanceOf(ConflictError);
    expect(await runsOf(automation.id)).toHaveLength(2);
  });

  it('retry creates a new linked succeeded run under the same key with exactly one notification; the failed run is preserved', async () => {
    const { opportunity, automation, event, key } = await seed('internal_notification.create');
    await failOnce(event);
    const [failed] = await runsOf(automation.id);

    const retried = await automations.retryRun(wsA, automation.id, failed.id);

    const [notification] = await notificationsFor(opportunity.id);
    expect(retried).toMatchObject({ status: 'succeeded', retryOfRunId: failed.id, triggerEventId: event.id, actionInput: { opportunityId: opportunity.id }, result: { notificationId: notification.id } });
    expect(await notificationsFor(opportunity.id)).toHaveLength(1);
    expect(await keyStatus(key)).toBe('completed');
    expect((await runsOf(automation.id))[0]).toEqual(failed);
    const audits = await db.client.select().from(aiActionRequests).where(eq(aiActionRequests.correlationId, event.id)).orderBy(aiActionRequests.createdAt);
    expect(audits.map((a) => a.executionStatus)).toEqual(['failed', 'executed']);

    await expect(automations.retryRun(wsA, automation.id, failed.id)).rejects.toThrow('already been executed successfully');
    await expect(automations.retryRun(wsA, automation.id, retried.id)).rejects.toThrow('Only a failed run can be retried.');
    expect(await runsOf(automation.id)).toHaveLength(2);
    expect(await notificationsFor(opportunity.id)).toHaveLength(1);
  });

  it('a failed retry is another linked failed run that stays retryable', async () => {
    const { opportunity, automation, event, key } = await seed('internal_notification.create');
    await failOnce(event);
    const [failed] = await runsOf(automation.id);

    vi.spyOn(notificationService, 'createForOpportunity').mockRejectedValueOnce(new Error('connection reset again'));
    const second = await automations.retryRun(wsA, automation.id, failed.id);
    expect(second).toMatchObject({ status: 'failed', retryOfRunId: failed.id, result: { retryable: true } });
    expect(await keyStatus(key)).toBe('failed');

    const third = await automations.retryRun(wsA, automation.id, second.id);
    expect(third).toMatchObject({ status: 'succeeded', retryOfRunId: second.id });
    expect(await notificationsFor(opportunity.id)).toHaveLength(1);
  });

  it('concurrent retries of the same failed run produce exactly one business effect', async () => {
    const { opportunity, automation, event } = await seed('internal_notification.create');
    await failOnce(event);
    const [failed] = await runsOf(automation.id);

    const results = await Promise.allSettled([1, 2, 3].map(() => automations.retryRun(wsA, automation.id, failed.id)));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const rejected of results.filter((r) => r.status === 'rejected')) expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    expect(await notificationsFor(opportunity.id)).toHaveLength(1);
    expect((await runsOf(automation.id)).map((r) => r.status)).toEqual(['failed', 'succeeded']);
  });

  it('retries generate_recommendations the same way, creating its recommendation once', async () => {
    const { opportunity, automation, event } = await seed('generate_recommendations');
    vi.spyOn(recommendationService, 'generate').mockRejectedValueOnce(new Error('connection reset'));
    await automations.handleRevenueOpportunityCreated(event);
    const [failed] = await runsOf(automation.id);
    expect(failed).toMatchObject({ status: 'failed', result: { retryable: true }, actionInput: {} });

    const retried = await automations.retryRun(wsA, automation.id, failed.id);

    expect(retried).toMatchObject({ status: 'succeeded', result: { recommendationsCount: 1 } });
    expect(await db.client.select().from(recommendations).where(eq(recommendations.sourceOpportunityId, opportunity.id))).toHaveLength(1);
  });

  it('a permanent failure (opportunity not found for the customer) is recorded not retryable and refused', async () => {
    const { automation, event } = await seed('internal_notification.create');
    const bogus = { ...event, id: randomUUID(), payload: { ...event.payload, opportunityId: randomUUID() } };
    await automations.handleRevenueOpportunityCreated(bogus);
    const [failed] = await runsOf(automation.id);
    expect(failed).toMatchObject({ status: 'failed', result: { retryable: false } });

    await expect(automations.retryRun(wsA, automation.id, failed.id)).rejects.toThrow('failed permanently');
    expect(await runsOf(automation.id)).toHaveLength(1);
  });

  it('isolation: another workspace or another automation cannot retry the run', async () => {
    const { automation, event } = await seed('internal_notification.create');
    await failOnce(event);
    const [failed] = await runsOf(automation.id);
    const other = await automations.create(wsA, { name: 'other', actionType: 'internal_notification.create' });

    await expect(automations.retryRun(wsB, automation.id, failed.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(automations.retryRun(wsA, other.id, failed.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await runsOf(automation.id)).toHaveLength(1);
  });
});
