import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { loadConfiguration } from '../../config/configuration';
import { workspaces } from '../../database/schema/workspaces';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { revenueOpportunities } from '../../database/schema/revenue-opportunities';
import { recommendations } from '../../database/schema/recommendations';
import { EventBus } from '../../common/events/event-bus.service';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { CustomerHealthService } from './customer-health.service';
import { RevenueOpportunityService } from './revenue-opportunity.service';
import { RecommendationService } from './recommendation.service';

type OpportunityStatus = (typeof revenueOpportunities.$inferInsert)['status'];

/**
 * Real-DB checks of the doc10 opportunity lifecycle driven by recommendations (#8 Outcome semantics):
 * generate → `recommended`, complete → `executed`, dismiss leaves the opportunity as is, and `converted`
 * is never set. Same approach as website-opportunity.db.spec.ts: isolated workspaces, every row deleted afterwards.
 */
// Many sequential round trips to the remote dev database per test — well over the 5s default on a slow link.
describe('Recommendation-driven opportunity lifecycle (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let recs: RecommendationService;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();

  async function customer(ws = workspaceId) {
    const [row] = await db.client.insert(canonicalCustomers).values({ workspaceId: ws, primaryEmail: `${randomUUID()}@example.com` }).returning();
    return row.id;
  }
  async function opportunity(canonicalCustomerId: string, status: OpportunityStatus = 'new', ws = workspaceId) {
    const [row] = await db.client
      .insert(revenueOpportunities)
      .values({ workspaceId: ws, canonicalCustomerId, type: 'win_back', status, priority: 'high', confidence: 80, reason: 'No order in 150 day(s).', recommendedAction: 'Send a win-back offer.' })
      .returning();
    return row.id;
  }
  async function statusOf(opportunityId: string) {
    const [row] = await db.client.select({ status: revenueOpportunities.status }).from(revenueOpportunities).where(eq(revenueOpportunities.id, opportunityId));
    return row.status;
  }
  async function recommendationFor(opportunityId: string) {
    const [row] = await db.client.select().from(recommendations).where(eq(recommendations.sourceOpportunityId, opportunityId));
    return row;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [loadConfiguration] }), DatabaseModule],
      providers: [
        RevenueOpportunityService,
        RecommendationService,
        { provide: CustomerIntelligenceService, useValue: {} },
        { provide: CustomerHealthService, useValue: { findCurrent: vi.fn(async () => null) } },
        { provide: EventBus, useValue: { emit: vi.fn() } },
        { provide: StructuredLoggerService, useValue: { event: vi.fn() } },
      ],
    }).compile();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    recs = moduleRef.get(RecommendationService);

    await db.client.insert(workspaces).values([
      { id: workspaceId, name: 'Recommendation Lifecycle Test Workspace' },
      { id: otherWorkspaceId, name: 'Recommendation Lifecycle Test Workspace (other)' },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (!db) return;
    for (const ws of [workspaceId, otherWorkspaceId]) {
      await db.client.delete(recommendations).where(eq(recommendations.workspaceId, ws));
      await db.client.delete(revenueOpportunities).where(eq(revenueOpportunities.workspaceId, ws));
      await db.client.delete(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, ws));
      await db.client.delete(workspaces).where(eq(workspaces.id, ws));
    }
    await moduleRef?.close();
  }, 60_000);

  it('marks an opportunity recommended once its recommendation is generated, and a repeat generate changes nothing', async () => {
    const id = await customer();
    const opp = await opportunity(id);

    await recs.generate(workspaceId, id);
    expect(await statusOf(opp)).toBe('recommended');
    expect((await recommendationFor(opp)).state).toBe('active');

    await recs.generate(workspaceId, id);
    expect(await statusOf(opp)).toBe('recommended');
    expect(await db.client.select().from(recommendations).where(eq(recommendations.sourceOpportunityId, opp))).toHaveLength(1);
  });

  it('moves the source opportunity to executed on complete; a repeat complete conflicts and a later generate does not move it back', async () => {
    const id = await customer();
    const opp = await opportunity(id);
    await recs.generate(workspaceId, id);
    const rec = await recommendationFor(opp);

    await recs.complete(workspaceId, id, rec.id);
    expect(await statusOf(opp)).toBe('executed');
    expect((await recommendationFor(opp)).state).toBe('completed');

    await expect(recs.complete(workspaceId, id, rec.id)).rejects.toThrow('Recommendation is already completed.');
    await expect(recs.dismiss(workspaceId, id, rec.id)).rejects.toThrow('Recommendation is already completed.');
    await recs.generate(workspaceId, id);
    expect(await statusOf(opp)).toBe('executed');
  });

  it('dismiss closes the recommendation but leaves the opportunity status as is (ignored is not set)', async () => {
    const id = await customer();
    const opp = await opportunity(id);
    await recs.generate(workspaceId, id);
    const rec = await recommendationFor(opp);

    await recs.dismiss(workspaceId, id, rec.id, 'Not relevant');
    expect((await recommendationFor(opp)).state).toBe('dismissed');
    expect(await statusOf(opp)).toBe('recommended');
  });

  it('completing one recommendation never changes another customer or workspace opportunity', async () => {
    const id = await customer();
    const sibling = await customer();
    const foreign = await customer(otherWorkspaceId);
    const opp = await opportunity(id);
    const siblingOpp = await opportunity(sibling);
    const foreignOpp = await opportunity(foreign, 'new', otherWorkspaceId);
    await recs.generate(workspaceId, id);
    await recs.generate(workspaceId, sibling);
    await recs.generate(otherWorkspaceId, foreign);
    const rec = await recommendationFor(opp);

    // Wrong customer / wrong workspace for this recommendation: not found, nothing moves.
    await expect(recs.complete(workspaceId, sibling, rec.id)).rejects.toThrow('No recommendation with that id exists for this customer.');
    await expect(recs.complete(otherWorkspaceId, id, rec.id)).rejects.toThrow('No recommendation with that id exists for this customer.');
    expect(await statusOf(opp)).toBe('recommended');

    await recs.complete(workspaceId, id, rec.id);
    expect(await statusOf(opp)).toBe('executed');
    expect(await statusOf(siblingOpp)).toBe('recommended');
    expect(await statusOf(foreignOpp)).toBe('recommended');
  });

  it('never moves a terminal opportunity (expired / converted) and never sets converted itself', async () => {
    const id = await customer();
    const expired = await opportunity(id, 'expired');
    const converted = await opportunity(id, 'converted');
    // Active recommendations on terminal opportunities (not produced by generate) — complete must still leave the status alone.
    const [expiredRec, convertedRec] = await db.client
      .insert(recommendations)
      .values([expired, converted].map((sourceOpportunityId) => ({ workspaceId, canonicalCustomerId: id, sourceOpportunityId, text: 'x', supportingSignals: {}, state: 'active' as const })))
      .returning();

    await recs.generate(workspaceId, id);
    await recs.complete(workspaceId, id, expiredRec.id);
    await recs.complete(workspaceId, id, convertedRec.id);

    expect(await statusOf(expired)).toBe('expired');
    expect(await statusOf(converted)).toBe('converted');

    const fresh = await opportunity(id);
    await recs.generate(workspaceId, id);
    await recs.complete(workspaceId, id, (await recommendationFor(fresh)).id);
    expect(await statusOf(fresh)).toBe('executed');
  });
});
