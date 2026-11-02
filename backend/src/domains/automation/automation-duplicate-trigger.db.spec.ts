import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq, inArray, like } from 'drizzle-orm';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { workspaces } from '../../database/schema/workspaces';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { automationDefinitions } from '../../database/schema/automation-definitions';
import { automationRuns } from '../../database/schema/automation-runs';
import { aiActionRequests } from '../../database/schema/ai-action-requests';
import { idempotencyKeys } from '../../database/schema/idempotency-keys';
import { createEvent } from '../../common/events/domain-event';
import type { RevenueOpportunityCreatedPayload } from '../intelligence-engines/revenue-opportunity.service';
import { AutomationService, DUPLICATE_TRIGGER_REASON } from './automation.service';

/**
 * Real-DB check of duplicate trigger handling through the real wiring (AiActionControlService, IdempotencyService,
 * RecommendationService): replaying the same `revenue_opportunity.created` event to the same automation records a
 * `skipped` run ("duplicate trigger"), executes nothing, and leaves the idempotency record and business state as they were.
 */
// Many sequential round trips to the remote dev database — well over the 5s default on a slow link.
describe('Automation duplicate trigger (real DB)', { timeout: 120_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let automations: AutomationService;
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
    await db.client.insert(workspaces).values([
      { id: wsA, name: 'Automation Duplicate Trigger Test A' },
      { id: wsB, name: 'Automation Duplicate Trigger Test B' },
    ]);
  }, 90_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [wsA, wsB];
    for (const ws of ids) await db.client.delete(idempotencyKeys).where(like(idempotencyKeys.key, `ai-action-automation:${ws}:%`));
    await db.client.delete(automationRuns).where(inArray(automationRuns.workspaceId, ids));
    await db.client.delete(automationDefinitions).where(inArray(automationDefinitions.workspaceId, ids));
    await db.client.delete(aiActionRequests).where(inArray(aiActionRequests.workspaceId, ids));
    await db.client.delete(recommendations).where(inArray(recommendations.workspaceId, ids));
    await db.client.delete(revenueOpportunities).where(inArray(revenueOpportunities.workspaceId, ids));
    await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    await moduleRef?.close();
  }, 90_000);

  it('a replayed trigger is a skipped "duplicate trigger" run with no second execution or business effect', async () => {
    const [customer] = await db.client.insert(canonicalCustomers).values({ workspaceId: wsA, primaryEmail: `${randomUUID()}@example.com` }).returning();
    const [opportunity] = await db.client
      .insert(revenueOpportunities)
      .values({ workspaceId: wsA, canonicalCustomerId: customer.id, type: 'reorder', priority: 'high', confidence: 80, reason: 'r', recommendedAction: 'a' })
      .returning();
    const automation = await automations.create(wsA, { name: 'reorder → recommendations', triggerType: 'revenue_opportunity.created', conditions: { typeIn: ['reorder'] } });
    const otherWorkspaceAutomation = await automations.create(wsB, { name: 'B unconditional', triggerType: 'revenue_opportunity.created' });
    const event = createEvent<RevenueOpportunityCreatedPayload>({
      type: 'revenue_opportunity.created',
      workspaceId: wsA,
      entityId: opportunity.id,
      payload: { opportunityId: opportunity.id, canonicalCustomerId: customer.id, type: 'reorder', priority: 'high', estimatedRevenue: null, confidence: 80 },
    });
    const state = async () => ({
      runs: await db.client.select().from(automationRuns).where(eq(automationRuns.workspaceId, wsA)).orderBy(automationRuns.createdAt),
      recs: await db.client.select().from(recommendations).where(eq(recommendations.workspaceId, wsA)),
      audits: await db.client.select().from(aiActionRequests).where(eq(aiActionRequests.workspaceId, wsA)).orderBy(aiActionRequests.createdAt),
      keys: await db.client.select().from(idempotencyKeys).where(like(idempotencyKeys.key, `ai-action-automation:${wsA}:%`)),
    });

    // First delivery: unchanged successful behavior.
    await automations.handleRevenueOpportunityCreated(event);
    const first = await state();
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]).toMatchObject({ automationId: automation.id, triggerEventId: event.id, status: 'succeeded', reason: null });
    expect(first.recs).toHaveLength(1);
    expect(first.audits.map((a) => a.executionStatus)).toEqual(['executed']);
    expect(first.keys).toEqual([expect.objectContaining({ key: `ai-action-automation:${wsA}:generate_recommendations:${automation.id}:${event.id}`, status: 'completed' })]);

    // Replay of the exact same event.
    await automations.handleRevenueOpportunityCreated(event);
    const replay = await state();
    expect(replay.runs).toHaveLength(2);
    expect(replay.runs[1]).toMatchObject({ automationId: automation.id, triggerEventId: event.id, status: 'skipped', reason: DUPLICATE_TRIGGER_REASON, result: null });
    expect(replay.runs.some((r) => r.status === 'failed')).toBe(false);
    expect(replay.recs).toEqual(first.recs);
    // The duplicate is audited (existing behavior) but is not an actionable request: nothing pending, nothing executed twice.
    expect(replay.audits.map((a) => a.executionStatus)).toEqual(['executed', 'duplicate']);
    expect(replay.audits.every((a) => a.approvalState === 'not_required')).toBe(true);
    expect(replay.keys).toEqual(first.keys);

    // Tenant isolation: workspace B's automation never saw workspace A's event.
    expect(await db.client.select().from(automationRuns).where(eq(automationRuns.automationId, otherWorkspaceAutomation.id))).toHaveLength(0);
    expect(await db.client.select().from(aiActionRequests).where(eq(aiActionRequests.workspaceId, wsB))).toHaveLength(0);
  });
});
