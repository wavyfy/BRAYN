import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { eq, inArray } from 'drizzle-orm';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { loadConfiguration } from '../../config/configuration';
import { workspaces } from '../../database/schema/workspaces';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { customerHealthStateHistory } from '../../database/schema/customer-health-state-history';
import { EventBus } from '../../common/events/event-bus.service';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { CustomerHealthService, HEALTH_HISTORY_LIMIT } from './customer-health.service';

/** Real-DB check of the health history read (#6) — ordering, cap, and workspace/customer isolation. */
describe('CustomerHealthService.getHistory() (real DB)', { timeout: 60_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let health: CustomerHealthService;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  let customerId: string;
  let otherCustomerId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [loadConfiguration] }), DatabaseModule],
      providers: [
        CustomerHealthService,
        { provide: CustomerIntelligenceService, useValue: {} },
        { provide: EventBus, useValue: { emit: vi.fn() } },
        { provide: StructuredLoggerService, useValue: { event: vi.fn() } },
      ],
    }).compile();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    health = moduleRef.get(CustomerHealthService);

    await db.client.insert(workspaces).values([
      { id: workspaceId, name: 'Health History Test Workspace' },
      { id: otherWorkspaceId, name: 'Health History Test Workspace (other)' },
    ]);
    [{ id: customerId }, { id: otherCustomerId }] = await db.client
      .insert(canonicalCustomers)
      .values([{ workspaceId }, { workspaceId }])
      .returning();

    const day = 24 * 60 * 60 * 1000;
    const base = Date.now() - 40 * day;
    const row = (ws: string, canonicalCustomerId: string, i: number) => ({
      workspaceId: ws,
      canonicalCustomerId,
      score: i,
      healthCategory: 'Critical',
      trend: 'stable',
      signals: {},
      reasonCodes: [],
      calculatedAt: new Date(base + i * day),
    });
    // Inserted out of order on purpose; 35 rows > the cap.
    await db.client.insert(customerHealthStateHistory).values([...Array.from({ length: 35 }, (_, i) => row(workspaceId, customerId, 34 - i))]);
    await db.client.insert(customerHealthStateHistory).values(row(workspaceId, otherCustomerId, 99));
    // Same customer id under another workspace id — must never be returned.
    await db.client.insert(customerHealthStateHistory).values({ ...row(otherWorkspaceId, customerId, 77), calculatedAt: new Date() });
  });

  afterAll(async () => {
    if (!db) return;
    await db.client.delete(customerHealthStateHistory).where(inArray(customerHealthStateHistory.workspaceId, [workspaceId, otherWorkspaceId]));
    await db.client.delete(canonicalCustomers).where(eq(canonicalCustomers.workspaceId, workspaceId));
    await db.client.delete(workspaces).where(inArray(workspaces.id, [workspaceId, otherWorkspaceId]));
    await moduleRef?.close();
  });

  it('returns the most recent entries newest first, capped, for this workspace and customer only', async () => {
    const history = await health.getHistory(workspaceId, customerId);

    expect(history).toHaveLength(HEALTH_HISTORY_LIMIT);
    expect(history.map((entry) => entry.score)).toEqual(Array.from({ length: HEALTH_HISTORY_LIMIT }, (_, i) => 34 - i));
    expect(history[0]).toEqual({ score: 34, healthCategory: 'Critical', trend: 'stable', calculatedAt: expect.any(Date) });
    expect(history.some((entry) => entry.score === 77 || entry.score === 99)).toBe(false);
  });

  it('returns an empty list for a customer with no calculations yet', async () => {
    expect(await health.getHistory(otherWorkspaceId, otherCustomerId)).toEqual([]);
  });
});
