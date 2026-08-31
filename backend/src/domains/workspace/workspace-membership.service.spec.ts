import { describe, expect, it, vi } from 'vitest';
import { WorkspaceMembershipService } from './workspace-membership.service';
import type { DatabaseService } from '../../database/database.service';

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
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

    const result = await service.addMember('ws_1', 'user_1', 'owner');

    expect(result).toEqual(created);
    expect(chain.values).toHaveBeenCalledWith({ workspaceId: 'ws_1', userId: 'user_1', role: 'owner' });
  });

  it('addMember() throws a ConflictError when the user is already a member', async () => {
    const chain = makeChain([]);
    const client = { insert: vi.fn(() => chain) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

    await expect(service.addMember('ws_1', 'user_1', 'owner')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('listByWorkspace() returns members for the workspace', async () => {
    const members = [{ id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' }];
    const chain = makeChain(members);
    const client = { select: vi.fn(() => chain) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

    const result = await service.listByWorkspace('ws_1');

    expect(result).toEqual(members);
  });

  it('listByUser() returns the workspaces a user belongs to with their role', async () => {
    const rows = [{ id: 'ws_1', name: 'Acme', role: 'owner' }];
    const chain = makeChain(rows);
    const client = { select: vi.fn(() => chain) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

    const result = await service.listByUser('user_1');

    expect(result).toEqual(rows);
  });

  it('findMembership() returns null when no membership exists', async () => {
    const chain = makeChain([]);
    const client = { select: vi.fn(() => chain) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

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
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

    await service.removeMember('ws_1', 'user_2');

    expect(client.delete).toHaveBeenCalled();
  });

  it('removeMember() throws NotFoundError when the membership does not exist', async () => {
    const client = { select: makeSelectQueue([[]]) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

    await expect(service.removeMember('ws_1', 'user_2')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('removeMember() throws ConflictError when removing the last owner', async () => {
    const membership = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' };
    const client = {
      select: makeSelectQueue([[membership], [{ owners: 1 }]]),
      delete: vi.fn(),
    };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

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
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

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
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

    const result = await service.updateRole('ws_1', 'user_2', 'admin');

    expect(result).toEqual(updated);
    expect(updateChain.set).toHaveBeenCalledWith({ role: 'admin' });
  });

  it('updateRole() throws NotFoundError when the membership does not exist', async () => {
    const client = { select: makeSelectQueue([[]]) };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

    await expect(service.updateRole('ws_1', 'user_2', 'admin')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('updateRole() throws ConflictError when demoting the last owner', async () => {
    const membership = { id: 'mem_1', workspaceId: 'ws_1', userId: 'user_1', role: 'owner' };
    const client = {
      select: makeSelectQueue([[membership], [{ owners: 1 }]]),
      update: vi.fn(),
    };
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

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
    const service = new WorkspaceMembershipService({ client } as unknown as DatabaseService);

    const result = await service.updateRole('ws_1', 'user_1', 'owner');

    expect(result).toEqual(updated);
  });
});
