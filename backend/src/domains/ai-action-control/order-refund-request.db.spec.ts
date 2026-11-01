import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { and, eq, inArray, like } from 'drizzle-orm';
import { AppModule } from '../../app.module';
import { DatabaseService } from '../../database/database.service';
import { RequestContext } from '../../common/logging/request-context';
import { ApprovalRequiredError, ConflictError, UnauthorizedError, ValidationError } from '../../common/errors/app-error';
import { workspaces } from '../../database/schema/workspaces';
import { users } from '../../database/schema/users';
import { integrations } from '../../database/schema/integrations';
import { canonicalCustomers } from '../../database/schema/canonical-customers';
import { commerceCustomers } from '../../database/schema/commerce-customers';
import { commerceOrders } from '../../database/schema/commerce-orders';
import { commerceRefunds } from '../../database/schema/commerce-refunds';
import { aiActionRequests } from '../../database/schema/ai-action-requests';
import { idempotencyKeys } from '../../database/schema/idempotency-keys';
import { AiActionControlService } from './ai-action-control.service';
import { ACTION_REGISTRY, type ActionRegistry } from './actions.registry';

/**
 * Real-DB checks of #8 Decision A `order.refund_request` through the real AppModule wiring (AiActionControlService +
 * registry + OrderService): request validation and single pending request per order, owner/admin only, approval-time
 * re-validation, simulated execution with no commerce write, deny, and repeated/concurrent approval safety.
 */
// Many sequential round trips to the remote dev database per test — well over the 5s default on a slow link.
describe('order.refund_request (real DB)', { timeout: 120_000 }, () => {
  let moduleRef: TestingModule;
  let db: DatabaseService;
  let control: AiActionControlService;
  let registry: ActionRegistry;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  let userId: string;
  const integrationIds: Record<string, string> = {};

  const as = <T>(role: string, fn: () => Promise<T>, ws = workspaceId) =>
    RequestContext.run({ correlationId: randomUUID(), workspaceId: ws, actorUserId: userId, actorRole: role }, fn);

  async function shopper(ws = workspaceId) {
    const [canonical] = await db.client.insert(canonicalCustomers).values({ workspaceId: ws, primaryEmail: `${randomUUID()}@example.com` }).returning();
    const [source] = await db.client
      .insert(commerceCustomers)
      .values({ workspaceId: ws, integrationId: integrationIds[ws], provider: 'shopify', externalId: randomUUID(), canonicalCustomerId: canonical.id })
      .returning();
    return { canonicalId: canonical.id, sourceId: source.id };
  }
  async function order(sourceCustomerId: string, totalPrice: string, options: { refunded?: string[]; cancelled?: boolean; ws?: string } = {}) {
    const ws = options.ws ?? workspaceId;
    const [o] = await db.client
      .insert(commerceOrders)
      .values({ workspaceId: ws, integrationId: integrationIds[ws], customerId: sourceCustomerId, provider: 'shopify', externalId: randomUUID(), totalPrice, sourceCancelledAt: options.cancelled ? new Date() : null })
      .returning();
    for (const amount of options.refunded ?? []) {
      await db.client.insert(commerceRefunds).values({ workspaceId: ws, integrationId: integrationIds[ws], orderId: o.id, provider: 'shopify', externalId: randomUUID(), totalRefunded: amount });
    }
    return o.id;
  }
  const request = (customerId: string, orderId: string, role = 'owner', key = randomUUID()) =>
    as(role, () => control.execute(registry.refundRequest, { orderId, reason: 'Damaged item' }, { workspaceId, customerId }, key));
  const rowsFor = (orderId: string) =>
    db.client
      .select()
      .from(aiActionRequests)
      .where(and(eq(aiActionRequests.workspaceId, workspaceId), eq(aiActionRequests.action, 'order.refund_request')))
      .then((rows) => rows.filter((row) => (row.inputSummary as { orderId?: string } | null)?.orderId === orderId));
  const pendingFor = async (orderId: string) => (await rowsFor(orderId)).filter((row) => row.approvalState === 'pending');

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    db = moduleRef.get(DatabaseService);
    if (!db.isConfigured()) {
      throw new Error('DATABASE_URL is not configured — this integration test requires the real dev database.');
    }
    control = moduleRef.get(AiActionControlService);
    registry = moduleRef.get(ACTION_REGISTRY);

    for (const ws of [workspaceId, otherWorkspaceId]) {
      await db.client.insert(workspaces).values({ id: ws, name: 'Refund Request Test Workspace' });
      const [integration] = await db.client.insert(integrations).values({ workspaceId: ws, provider: 'shopify' }).returning();
      integrationIds[ws] = integration.id;
    }
    [{ id: userId }] = await db.client.insert(users).values({ clerkUserId: `test_refund_request_${randomUUID()}` }).returning({ id: users.id });
  }, 90_000);

  afterAll(async () => {
    if (!db?.isConfigured()) return;
    const ids = [workspaceId, otherWorkspaceId];
    const requestIds = (await db.client.select({ id: aiActionRequests.id }).from(aiActionRequests).where(inArray(aiActionRequests.workspaceId, ids))).map((r) => r.id);
    for (const id of requestIds) await db.client.delete(idempotencyKeys).where(like(idempotencyKeys.key, `ai-action-approval:${id}`));
    await db.client.delete(aiActionRequests).where(inArray(aiActionRequests.workspaceId, ids));
    await db.client.delete(commerceRefunds).where(inArray(commerceRefunds.workspaceId, ids));
    await db.client.delete(commerceOrders).where(inArray(commerceOrders.workspaceId, ids));
    await db.client.delete(commerceCustomers).where(inArray(commerceCustomers.workspaceId, ids));
    await db.client.delete(canonicalCustomers).where(inArray(canonicalCustomers.workspaceId, ids));
    await db.client.delete(integrations).where(inArray(integrations.workspaceId, ids));
    await db.client.delete(workspaces).where(inArray(workspaces.id, ids));
    if (userId) await db.client.delete(users).where(eq(users.id, userId));
    await moduleRef?.close();
  }, 90_000);

  it('a valid owner/admin request is recorded pending approval (high risk), never executed', async () => {
    const c = await shopper();
    for (const role of ['owner', 'admin']) {
      const orderId = await order(c.sourceId, '40.00');
      await expect(request(c.canonicalId, orderId, role)).rejects.toBeInstanceOf(ApprovalRequiredError);
      const [row] = await pendingFor(orderId);
      expect(row).toMatchObject({ actorRole: role, riskLevel: 'high', approvalState: 'pending', executionStatus: 'blocked_approval', customerId: c.canonicalId, resultSummary: null });
      expect(row.inputSummary).toEqual({ orderId, reason: 'Damaged item' });
    }
  });

  it('marketing/support/analyst are rejected before anything is recorded as pending', async () => {
    const c = await shopper();
    const orderId = await order(c.sourceId, '40.00');
    for (const role of ['marketing', 'support', 'analyst']) {
      await expect(request(c.canonicalId, orderId, role)).rejects.toBeInstanceOf(UnauthorizedError);
    }
    const rows = await rowsFor(orderId);
    expect(rows.every((row) => row.executionStatus === 'blocked_permission')).toBe(true);
    expect(await pendingFor(orderId)).toHaveLength(0);
  });

  it('blocks another customer\'s / another workspace\'s order, a cancelled order, and a fully refunded order', async () => {
    const c = await shopper();
    const other = await shopper();
    const foreign = await shopper(otherWorkspaceId);
    const cases: [string, string][] = [
      [await order(other.sourceId, '40.00'), 'No order with that id exists for this customer.'],
      [await order(foreign.sourceId, '40.00', { ws: otherWorkspaceId }), 'No order with that id exists for this customer.'],
      [await order(c.sourceId, '40.00', { cancelled: true }), 'The order is cancelled.'],
      [await order(c.sourceId, '40.00', { refunded: ['15.00', '25.00'] }), 'The order has no refundable amount remaining.'],
    ];
    for (const [orderId, reason] of cases) {
      await expect(request(c.canonicalId, orderId)).rejects.toThrow(new ValidationError(reason));
      expect(await pendingFor(orderId)).toHaveLength(0);
      expect((await rowsFor(orderId))[0]).toMatchObject({ executionStatus: 'blocked_validation', failureReason: reason });
    }
  });

  it('allows only one pending request per order, also under concurrent requests', async () => {
    const c = await shopper();
    const orderId = await order(c.sourceId, '40.00');
    await expect(request(c.canonicalId, orderId)).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(request(c.canonicalId, orderId)).rejects.toBeInstanceOf(ConflictError);
    expect(await pendingFor(orderId)).toHaveLength(1);

    const raced = await order(c.sourceId, '10.00');
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => request(c.canonicalId, raced)));
    const reasons = results.map((r) => (r.status === 'rejected' ? r.reason : null));
    expect(reasons.filter((e) => e instanceof ApprovalRequiredError)).toHaveLength(1);
    expect(reasons.filter((e) => e instanceof ConflictError)).toHaveLength(9);
    expect(await pendingFor(raced)).toHaveLength(1);
  });

  it('approval executes the simulation: remaining amount, mode simulated, and no commerce write', async () => {
    const c = await shopper();
    const orderId = await order(c.sourceId, '40.00', { refunded: ['15.50'] });
    await expect(request(c.canonicalId, orderId)).rejects.toBeInstanceOf(ApprovalRequiredError);
    const [pending] = await pendingFor(orderId);
    const [orderBefore] = await db.client.select().from(commerceOrders).where(eq(commerceOrders.id, orderId));
    const refundsBefore = await db.client.select().from(commerceRefunds).where(eq(commerceRefunds.orderId, orderId));

    await as('admin', () => control.approve(pending.id, { workspaceId }));

    const [row] = await db.client.select().from(aiActionRequests).where(eq(aiActionRequests.id, pending.id));
    expect(row).toMatchObject({ approvalState: 'approved', executionStatus: 'executed', decidedByUserId: userId, failureReason: null });
    expect(row.resultSummary).toEqual({ mode: 'simulated', orderId, amount: '24.50' });
    expect((await db.client.select().from(commerceOrders).where(eq(commerceOrders.id, orderId)))[0]).toEqual(orderBefore);
    expect(await db.client.select().from(commerceRefunds).where(eq(commerceRefunds.orderId, orderId))).toEqual(refundsBefore);
    expect(await db.client.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, `ai-action-approval:${pending.id}`))).toHaveLength(1);
  });

  it('approval re-validates: an order cancelled after the request fails without executing', async () => {
    const c = await shopper();
    const orderId = await order(c.sourceId, '40.00');
    await expect(request(c.canonicalId, orderId)).rejects.toBeInstanceOf(ApprovalRequiredError);
    const [pending] = await pendingFor(orderId);
    await db.client.update(commerceOrders).set({ sourceCancelledAt: new Date() }).where(eq(commerceOrders.id, orderId));

    await expect(as('owner', () => control.approve(pending.id, { workspaceId }))).rejects.toThrow(new ValidationError('The order is cancelled.'));

    const [row] = await db.client.select().from(aiActionRequests).where(eq(aiActionRequests.id, pending.id));
    expect(row).toMatchObject({ approvalState: 'approved', executionStatus: 'failed', failureReason: 'The order is cancelled.', resultSummary: null });
    expect(await db.client.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, `ai-action-approval:${pending.id}`))).toHaveLength(0);
    await expect(as('owner', () => control.approve(pending.id, { workspaceId }))).rejects.toBeInstanceOf(ConflictError);
  });

  it('deny records the decision and executes nothing; the order can then be requested again', async () => {
    const c = await shopper();
    const orderId = await order(c.sourceId, '40.00');
    await expect(request(c.canonicalId, orderId)).rejects.toBeInstanceOf(ApprovalRequiredError);
    const [pending] = await pendingFor(orderId);

    await as('owner', () => control.deny(pending.id, { workspaceId }));

    const [row] = await db.client.select().from(aiActionRequests).where(eq(aiActionRequests.id, pending.id));
    expect(row).toMatchObject({ approvalState: 'denied', executionStatus: 'blocked_approval', resultSummary: null, decidedByUserId: userId });
    await expect(as('owner', () => control.approve(pending.id, { workspaceId }))).rejects.toBeInstanceOf(ConflictError);
    await expect(request(c.canonicalId, orderId)).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('repeated and concurrent approvals execute once', async () => {
    const c = await shopper();
    const orderId = await order(c.sourceId, '40.00');
    await expect(request(c.canonicalId, orderId)).rejects.toBeInstanceOf(ApprovalRequiredError);
    const [pending] = await pendingFor(orderId);

    const results = await Promise.allSettled([1, 2, 3].map(() => as('owner', () => control.approve(pending.id, { workspaceId }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof ConflictError)).toBe(true);
    await expect(as('owner', () => control.approve(pending.id, { workspaceId }))).rejects.toBeInstanceOf(ConflictError);

    const [row] = await db.client.select().from(aiActionRequests).where(eq(aiActionRequests.id, pending.id));
    expect(row).toMatchObject({ approvalState: 'approved', executionStatus: 'executed' });
    expect(row.resultSummary).toEqual({ mode: 'simulated', orderId, amount: '40.00' });
  });

  it('an approval in another workspace cannot reach the request', async () => {
    const c = await shopper();
    const orderId = await order(c.sourceId, '40.00');
    await expect(request(c.canonicalId, orderId)).rejects.toBeInstanceOf(ApprovalRequiredError);
    const [pending] = await pendingFor(orderId);

    await expect(as('owner', () => control.approve(pending.id, { workspaceId: otherWorkspaceId }), otherWorkspaceId)).rejects.toThrow('No AI action request');
    expect((await pendingFor(orderId))[0].id).toBe(pending.id);
  });
});
