import { describe, expect, it, vi } from 'vitest';
import { WorkspaceService } from './workspace.service';
import type { DatabaseService } from '../../database/database.service';

function makeChain(finalResult: unknown) {
  return {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(async () => finalResult),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn(async () => finalResult),
  };
}

describe('WorkspaceService', () => {
  it('create() inserts and returns the created workspace', async () => {
    const created = { id: 'ws_1', name: 'Acme' };
    const chain = makeChain([created]);
    const client = { insert: vi.fn(() => chain) };
    const service = new WorkspaceService({ client } as unknown as DatabaseService);

    const result = await service.create('Acme');

    expect(result).toEqual(created);
    expect(client.insert).toHaveBeenCalledTimes(1);
    expect(chain.values).toHaveBeenCalledWith({ name: 'Acme' });
  });

  it('findById() returns the workspace when found', async () => {
    const found = { id: 'ws_1', name: 'Acme' };
    const chain = makeChain([found]);
    const client = { select: vi.fn(() => chain) };
    const service = new WorkspaceService({ client } as unknown as DatabaseService);

    const result = await service.findById('ws_1');

    expect(result).toEqual(found);
  });

  it('findById() returns null when not found', async () => {
    const chain = makeChain([]);
    const client = { select: vi.fn(() => chain) };
    const service = new WorkspaceService({ client } as unknown as DatabaseService);

    const result = await service.findById('missing');

    expect(result).toBeNull();
  });
});
