import { describe, expect, it, vi } from 'vitest';
import { MerchantKnowledgeService } from './merchant-knowledge.service';
import type { DatabaseService } from '../../database/database.service';

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => result),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

function makeSelectQueue(results: unknown[]) {
  let i = 0;
  return vi.fn(() => makeSelectChain(results[i++]));
}

function makeInsertChain(result?: unknown) {
  if (result === undefined) {
    return { values: vi.fn(async () => undefined) };
  }
  return { values: vi.fn(() => ({ returning: vi.fn(async () => [result]) })) };
}

describe('MerchantKnowledgeService', () => {
  describe('create()', () => {
    it('creates the entry at version 1 and records history', async () => {
      const created = { id: 'entry_1', type: 'policy', title: 'Refunds', content: 'No refunds after 30 days.', version: 1 };
      const insertEntry = makeInsertChain(created);
      const insertHistory = makeInsertChain();
      const insert = vi.fn().mockReturnValueOnce(insertEntry).mockReturnValueOnce(insertHistory);
      const service = new MerchantKnowledgeService({ client: { insert } } as unknown as DatabaseService);

      const result = await service.create('ws_1', { type: 'policy', title: 'Refunds', content: 'No refunds after 30 days.' });

      expect(result).toEqual(created);
      expect(insertHistory.values).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'entry_1', version: 1 }));
    });
  });

  describe('get()', () => {
    it('throws NotFoundError when no entry exists in this workspace', async () => {
      const select = makeSelectQueue([[]]);
      const service = new MerchantKnowledgeService({ client: { select } } as unknown as DatabaseService);

      await expect(service.get('ws_1', 'entry_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns the entry', async () => {
      const entry = { id: 'entry_1', type: 'knowledge', title: 'Shipping', content: 'Ships in 3-5 days.', version: 1 };
      const select = makeSelectQueue([[entry]]);
      const service = new MerchantKnowledgeService({ client: { select } } as unknown as DatabaseService);

      const result = await service.get('ws_1', 'entry_1');

      expect(result).toEqual(entry);
    });
  });

  describe('update()', () => {
    it('throws NotFoundError when no entry exists in this workspace', async () => {
      const select = makeSelectQueue([[]]);
      const service = new MerchantKnowledgeService({ client: { select } } as unknown as DatabaseService);

      await expect(service.update('ws_1', 'entry_missing', { title: 'New title' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('bumps the version, keeps unset fields, and records history', async () => {
      const current = { id: 'entry_1', type: 'policy', title: 'Refunds', content: 'No refunds after 30 days.', version: 1 };
      const updated = { ...current, content: 'No refunds after 14 days.', version: 2 };
      const select = makeSelectQueue([[current]]);
      const updateChain = { set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => [updated]) })) })) };
      const update = vi.fn(() => updateChain);
      const insertHistory = makeInsertChain();
      const insert = vi.fn(() => insertHistory);
      const service = new MerchantKnowledgeService({ client: { select, update, insert } } as unknown as DatabaseService);

      const result = await service.update('ws_1', 'entry_1', { content: 'No refunds after 14 days.' });

      expect(result).toEqual(updated);
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ title: 'Refunds', content: 'No refunds after 14 days.', version: 2 }));
      expect(insertHistory.values).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'entry_1', version: 2 }));
    });
  });

  describe('list()', () => {
    it('returns whatever the query yields', async () => {
      const rows = [{ id: 'entry_1' }];
      const select = vi.fn(() => makeSelectChain(rows));
      const service = new MerchantKnowledgeService({ client: { select } } as unknown as DatabaseService);

      const result = await service.list('ws_1');

      expect(result).toEqual(rows);
    });
  });

  describe('findRelevant()', () => {
    it('scores entries by keyword overlap with the query and returns highest-scoring first', async () => {
      const shipping = { id: 'entry_1', type: 'knowledge', title: 'Shipping', content: 'We ship worldwide within 3-5 days.' };
      const returns = { id: 'entry_2', type: 'knowledge', title: 'Returns', content: 'Shipping delays do not extend the return window.' };
      const unrelated = { id: 'entry_3', type: 'knowledge', title: 'Sizing', content: 'Check the size chart before ordering.' };
      const select = vi.fn(() => makeSelectChain([shipping, returns, unrelated]));
      const service = new MerchantKnowledgeService({ client: { select } } as unknown as DatabaseService);

      const result = await service.findRelevant('ws_1', 'knowledge', 'How long does shipping take?');

      // "shipping" matches both entries (score 1 each) via a stable sort; "sizing" matches neither and is excluded.
      expect(result.map((entry) => entry.id)).toEqual(['entry_1', 'entry_2']);
    });

    it('returns an empty array when the query has no scoreable words', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'entry_1', title: 'Shipping', content: 'Ships in 3-5 days.' }]));
      const service = new MerchantKnowledgeService({ client: { select } } as unknown as DatabaseService);

      const result = await service.findRelevant('ws_1', 'knowledge', '??');

      expect(result).toEqual([]);
    });

    it('returns an empty array when no entry matches any query word', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'entry_1', title: 'Sizing', content: 'Check the size chart.' }]));
      const service = new MerchantKnowledgeService({ client: { select } } as unknown as DatabaseService);

      const result = await service.findRelevant('ws_1', 'knowledge', 'refund policy');

      expect(result).toEqual([]);
    });

    it('caps results at 5 entries', async () => {
      const entries = Array.from({ length: 8 }, (_, i) => ({ id: `entry_${i}`, title: 'Shipping', content: 'shipping shipping shipping' }));
      const select = vi.fn(() => makeSelectChain(entries));
      const service = new MerchantKnowledgeService({ client: { select } } as unknown as DatabaseService);

      const result = await service.findRelevant('ws_1', 'knowledge', 'shipping');

      expect(result).toHaveLength(5);
    });

    it('delegates workspace+type scoping to list() — the same scoping list() itself enforces', async () => {
      const select = vi.fn(() => makeSelectChain([]));
      const client = { select };
      const service = new MerchantKnowledgeService({ client } as unknown as DatabaseService);
      const listSpy = vi.spyOn(service, 'list');

      await service.findRelevant('ws_2', 'policy', 'refund');

      expect(listSpy).toHaveBeenCalledWith('ws_2', 'policy');
    });
  });

  describe('getHistory()', () => {
    it('throws NotFoundError when no entry exists in this workspace', async () => {
      const select = makeSelectQueue([[]]);
      const service = new MerchantKnowledgeService({ client: { select } } as unknown as DatabaseService);

      await expect(service.getHistory('ws_1', 'entry_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns version history newest first', async () => {
      const rows = [{ version: 2 }, { version: 1 }];
      const select = makeSelectQueue([[{ id: 'entry_1' }], rows]);
      const service = new MerchantKnowledgeService({ client: { select } } as unknown as DatabaseService);

      const result = await service.getHistory('ws_1', 'entry_1');

      expect(result).toEqual(rows);
    });
  });
});
