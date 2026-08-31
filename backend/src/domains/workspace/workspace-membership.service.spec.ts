import { describe, expect, it, vi } from 'vitest';
import { WorkspaceMembershipService } from './workspace-membership.service';
import type { DatabaseService } from '../../database/database.service';

function makeChain(finalResult: unknown) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
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
});
