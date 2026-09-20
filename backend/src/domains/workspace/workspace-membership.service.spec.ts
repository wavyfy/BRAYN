import { describe, expect, it, vi } from 'vitest';
import { WorkspaceMembershipService } from './workspace-membership.service';
import type { DatabaseService } from '../../database/database.service';
import type { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import { RequestContext } from '../../common/logging/request-context';

function makeLogger(): StructuredLoggerService {
  return { event: vi.fn() } as unknown as StructuredLoggerService;
}

/** Every audited method reads the actor from RequestContext (same pattern as ReadToolsService/MerchantBusinessAnalystService) — tests that care about the audit row run inside this. */
function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  return RequestContext.run({ correlationId: 'corr-1', userId: 'clerk_1', workspaceId: 'ws_1', actorUserId: 'user_1', actorRole: 'owner' }, fn);
}

/** A no-op insert for tests that don't care about the audit write's own content — just lets `recordAudit` resolve cleanly instead of throwing on a missing `insert` mock. */
function noopInsert() {
  return vi.fn(() => makeChain(undefined));
}

function makeChain(finalResult: unknown) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    set: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn(async () => finalResult),
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => finalResult),
    // Drizzle's query builder is itself awaitable at any point in the
    // chain (e.g. `.where(...)` with no trailing `.limit()`) — make the
    // mock behave the same way instead of hardcoding one terminal method.
    then: (resolve: (value: unknown) => void) => resolve(finalResult),
  };
  return chain;
}

describe('WorkspaceMembershipService', () => {
  it('addMember() inserts and returns the created membership', async () => {
    const created = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' };
    const chain = makeChain([created]);
    const client = { insert: vi.fn(() => chain) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    const result = await service.addMember('ws_1', 'user_1', 'owner');

    expect(result).toEqual(created);
    expect(chain.values).toHaveBeenCalledWith({ workspaceId: 'ws_1', userId: 'user_1', role: 'owner' });
  });

  it('addMember() throws a ConflictError when the user is already a member', async () => {
    const chain = makeChain([]);
    const client = { insert: vi.fn(() => chain) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    await expect(service.addMember('ws_1', 'user_1', 'owner')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('listByWorkspace() returns members for the workspace', async () => {
    const members = [{ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' }];
    const chain = makeChain(members);
    const client = { select: vi.fn(() => chain) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    const result = await service.listByWorkspace('ws_1');

    expect(result).toEqual(members);
  });

  it('listByUser() returns the workspaces a user belongs to with their role', async () => {
    const rows = [{ id: 'ws_1', name: 'Acme', role: 'owner' }];
    const chain = makeChain(rows);
    const client = { select: vi.fn(() => chain) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    const result = await service.listByUser('user_1');

    expect(result).toEqual(rows);
  });

  it('findMembership() returns null when no membership exists', async () => {
    const chain = makeChain([]);
    const client = { select: vi.fn(() => chain) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    const result = await service.findMembership('ws_1', 'user_1');

    expect(result).toBeNull();
  });

  function makeSelectQueue(results: unknown[]) {
    let i = 0;
    return vi.fn(() => makeChain(results[i++]));
  }

  it('removeMember() deletes a non-owner membership', async () => {
    const membership = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_2', role: 'support' };
    const deleteChain = makeChain(undefined);
    const client = {
      select: makeSelectQueue([[membership]]),
      delete: vi.fn(() => deleteChain),
    };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    await service.removeMember('ws_1', 'user_2');

    expect(client.delete).toHaveBeenCalled();
  });

  it('removeMember() throws NotFoundError when the membership does not exist', async () => {
    const client = { select: makeSelectQueue([[]]) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    await expect(service.removeMember('ws_1', 'user_2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('removeMember() throws ConflictError when removing the last owner', async () => {
    const membership = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' };
    const client = {
      select: makeSelectQueue([[membership], [{ owners: 1 }]]),
      delete: vi.fn(),
    };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    await expect(service.removeMember('ws_1', 'user_1')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(client.delete).not.toHaveBeenCalled();
  });

  it('removeMember() allows removing an owner when other owners remain', async () => {
    const membership = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' };
    const deleteChain = makeChain(undefined);
    const client = {
      select: makeSelectQueue([[membership], [{ owners: 2 }]]),
      delete: vi.fn(() => deleteChain),
    };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    await service.removeMember('ws_1', 'user_1');

    expect(client.delete).toHaveBeenCalled();
  });

  it('updateRole() updates the role for a non-owner membership', async () => {
    const membership = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_2', role: 'support' };
    const updated = { ...membership, role: 'admin' };
    const updateChain = makeChain([updated]);
    const client = {
      select: makeSelectQueue([[membership]]),
      update: vi.fn(() => updateChain),
    };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    const result = await service.updateRole('ws_1', 'user_2', 'admin');

    expect(result).toEqual(updated);
    expect(updateChain.set).toHaveBeenCalledWith({ role: 'admin' });
  });

  it('updateRole() throws NotFoundError when the membership does not exist', async () => {
    const client = { select: makeSelectQueue([[]]) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    await expect(service.updateRole('ws_1', 'user_2', 'admin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('updateRole() throws ConflictError when demoting the last owner', async () => {
    const membership = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' };
    const client = {
      select: makeSelectQueue([[membership], [{ owners: 1 }]]),
      update: vi.fn(),
    };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    await expect(service.updateRole('ws_1', 'user_1', 'admin')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(client.update).not.toHaveBeenCalled();
  });

  it('updateRole() allows an owner keeping the owner role without a last-owner check', async () => {
    const membership = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' };
    const updated = { ...membership };
    const updateChain = makeChain([updated]);
    const client = {
      select: makeSelectQueue([[membership]]),
      update: vi.fn(() => updateChain),
    };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    const result = await service.updateRole('ws_1', 'user_1', 'owner');

    expect(result).toEqual(updated);
  });

  it('transferOwnership() throws ValidationError when transferring to self', async () => {
    const client = {};
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

    await expect(service.transferOwnership('ws_1', 'user_1', 'user_1')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('transferOwnership() throws NotFoundError when the target is not a member', async () => {
    const tx = { select: makeSelectQueue([[]]) };
    const database = { transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)) };
    const service = new WorkspaceMembershipService(database as unknown as DatabaseService, makeLogger());

    await expect(service.transferOwnership('ws_1', 'user_1', 'user_2')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('transferOwnership() demotes the caller and promotes the target', async () => {
    const target = { id: 'mem_2', workspaceId: 'ws_1', userId: 'user_2', role: 'support' };
    const promoted = { ...target, role: 'owner' };
    const demoteChain = makeChain(undefined);
    const promoteChain = makeChain([promoted]);
    let updateCalls = 0;
    const tx = {
      select: makeSelectQueue([[target]]),
      update: vi.fn(() => (updateCalls++ === 0 ? demoteChain : promoteChain)),
    };
    const database = { transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)) };
    const service = new WorkspaceMembershipService(database as unknown as DatabaseService, makeLogger());

    const result = await service.transferOwnership('ws_1', 'user_1', 'user_2');

    expect(result).toEqual(promoted);
    expect(demoteChain.set).toHaveBeenCalledWith({ role: 'admin' });
    expect(promoteChain.set).toHaveBeenCalledWith({ role: 'owner' });
  });

  describe('administrative audit trail (doc18 — Permission changes / Administrative changes)', () => {
    it('addMember() records a member_added audit event scoped to the workspace, with no extraneous fields', async () => {
      const created = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_2', role: 'support' };
      const chain = makeChain([created]);
      const insert = vi.fn(() => chain);
      const client = { insert };
      const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

      await asOwner(() => service.addMember('ws_1', 'user_2', 'support'));

      expect(chain.values).toHaveBeenCalledWith({
        workspaceId: 'ws_1',
        actorUserId: 'user_1',
        actorRole: 'owner',
        action: 'member_added',
        targetUserId: 'user_2',
        metadata: { role: 'support' },
      });
    });

    it('removeMember() records a member_removed audit event with the removed member\'s prior role', async () => {
      const membership = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_2', role: 'support' };
      const deleteChain = makeChain(undefined);
      const auditChain = makeChain(undefined);
      const insert = vi.fn(() => auditChain);
      const client = {
        select: makeSelectQueue([[membership]]),
        delete: vi.fn(() => deleteChain),
        insert,
      };
      const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

      await asOwner(() => service.removeMember('ws_1', 'user_2'));

      expect(auditChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'member_removed', targetUserId: 'user_2', metadata: { role: 'support' } }),
      );
    });

    it('updateRole() records a role_changed audit event with fromRole/toRole', async () => {
      const membership = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_2', role: 'support' };
      const updated = { ...membership, role: 'admin' };
      const updateChain = makeChain([updated]);
      const auditChain = makeChain(undefined);
      const insert = vi.fn(() => auditChain);
      const client = { select: makeSelectQueue([[membership]]), update: vi.fn(() => updateChain), insert };
      const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

      await asOwner(() => service.updateRole('ws_1', 'user_2', 'admin'));

      expect(auditChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'role_changed', targetUserId: 'user_2', metadata: { fromRole: 'support', toRole: 'admin' } }),
      );
    });

    it('updateRole() does not record an audit event when the role does not actually change', async () => {
      const membership = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' };
      const updateChain = makeChain([{ ...membership }]);
      const insert = vi.fn();
      const client = { select: makeSelectQueue([[membership]]), update: vi.fn(() => updateChain), insert };
      const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

      await asOwner(() => service.updateRole('ws_1', 'user_1', 'owner'));

      expect(insert).not.toHaveBeenCalled();
    });

    it('transferOwnership() records an ownership_transferred audit event after the transaction commits', async () => {
      const target = { id: 'mem_2', workspaceId: 'ws_1', userId: 'user_2', role: 'support' };
      const promoted = { ...target, role: 'owner' };
      const demoteChain = makeChain(undefined);
      const promoteChain = makeChain([promoted]);
      const auditChain = makeChain(undefined);
      let updateCalls = 0;
      const tx = {
        select: makeSelectQueue([[target]]),
        update: vi.fn(() => (updateCalls++ === 0 ? demoteChain : promoteChain)),
      };
      const insert = vi.fn(() => auditChain);
      const database = { transaction: vi.fn((fn: (tx: unknown) => unknown) => fn(tx)), client: { insert } };
      const service = new WorkspaceMembershipService(database as unknown as DatabaseService, makeLogger());

      await asOwner(() => service.transferOwnership('ws_1', 'user_1', 'user_2'));

      expect(auditChain.values).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'ownership_transferred', targetUserId: 'user_2', metadata: { fromUserId: 'user_1' } }),
      );
    });

    it('does not fail the administrative operation when the audit write itself fails', async () => {
      const created = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_2', role: 'support' };
      const memberChain = makeChain([created]);
      const insert = vi.fn().mockReturnValueOnce(memberChain).mockImplementationOnce(() => {
        throw new Error('db down');
      });
      const logger = makeLogger();
      const client = { insert };
      const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, logger);

      const result = await asOwner(() => service.addMember('ws_1', 'user_2', 'support'));

      expect(result).toEqual(created);
      expect(logger.event).toHaveBeenCalledWith(
        'error',
        'Failed to record workspace administrative audit event',
        'WorkspaceMembershipService',
        expect.objectContaining({ errorType: 'Error' }),
      );
    });

    it('records no audit event when there is no actor in RequestContext (no RequestContext.run wrapper)', async () => {
      const created = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_2', role: 'support' };
      const chain = makeChain([created]);
      const insert = vi.fn(() => chain);
      const client = { insert };
      const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

      await service.addMember('ws_1', 'user_2', 'support');

      // Exactly one insert call (the membership itself) — no second call for the audit row.
      expect(insert).toHaveBeenCalledTimes(1);
    });

    it('never writes credentials, tokens, or secrets into audit metadata — only role/user identifiers', async () => {
      const created = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_2', role: 'support' };
      const chain = makeChain([created]);
      const insert = vi.fn(() => chain);
      const client = { insert };
      const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService, makeLogger());

      await asOwner(() => service.addMember('ws_1', 'user_2', 'support'));

      const valuesMock = chain.values as ReturnType<typeof vi.fn>;
      const auditRow = valuesMock.mock.calls.find((call: unknown[]) => (call[0] as { action?: string }).action === 'member_added')?.[0];
      expect(Object.keys(auditRow as object).sort()).toEqual(
        ['action', 'actorRole', 'actorUserId', 'metadata', 'targetUserId', 'workspaceId'].sort(),
      );
      expect(JSON.stringify(auditRow)).not.toMatch(/token|password|secret|credential/i);
    });
  });
});
