import { describe, expect, it, vi } from 'vitest';
import { UserService } from './user.service';
import type { DatabaseService } from '../../database/database.service';

function makeChain(finalResult: unknown) {
  return {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn(async () => finalResult),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => finalResult),
  };
}

describe('UserService', () => {
  it('findOrCreateByClerkId() returns the existing user without inserting', async () => {
    const existing = { id: 'user_1', clerkUserId: 'clerk_1' };
    const selectChain = makeChain([existing]);
    const client = { select: vi.fn(() => selectChain), insert: vi.fn() };
    const service = new UserService({ client } as unknown as DatabaseService);

    const result = await service.findOrCreateByClerkId('clerk_1');

    expect(result).toEqual(existing);
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('findOrCreateByClerkId() creates a user when none exists', async () => {
    const created = { id: 'user_1', clerkUserId: 'clerk_1' };
    const selectChain = makeChain([]);
    const insertChain = makeChain([created]);
    const client = {
      select: vi.fn(() => selectChain),
      insert: vi.fn(() => insertChain),
    };
    const service = new UserService({ client } as unknown as DatabaseService);

    const result = await service.findOrCreateByClerkId('clerk_1');

    expect(result).toEqual(created);
    expect(insertChain.values).toHaveBeenCalledWith({ clerkUserId: 'clerk_1' });
  });

  it('findOrCreateByClerkId() falls back to the winning row on a concurrent-insert race', async () => {
    const winner = { id: 'user_1', clerkUserId: 'clerk_1' };
    const initialSelect = makeChain([]);
    const insertChain = makeChain([]);
    const raceSelect = makeChain([winner]);
    const client = {
      select: vi.fn().mockReturnValueOnce(initialSelect).mockReturnValueOnce(raceSelect),
      insert: vi.fn(() => insertChain),
    };
    const service = new UserService({ client } as unknown as DatabaseService);

    const result = await service.findOrCreateByClerkId('clerk_1');

    expect(result).toEqual(winner);
  });
});
