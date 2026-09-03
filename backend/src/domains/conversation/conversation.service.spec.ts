import { describe, expect, it, vi } from 'vitest';
import { ConversationService } from './conversation.service';
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

function makeInsertChain(result: unknown) {
  return { values: vi.fn(() => ({ returning: vi.fn(async () => [result]) })) };
}

describe('ConversationService', () => {
  describe('startConversation()', () => {
    it('throws NotFoundError when the canonical customer does not exist in this workspace', async () => {
      const select = makeSelectQueue([[]]);
      const service = new ConversationService({ client: { select } } as unknown as DatabaseService);

      await expect(service.startConversation('ws_1', 'canon_missing', { channel: 'whatsapp' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns the existing open conversation on this channel instead of creating a duplicate', async () => {
      const existing = { id: 'conv_1', status: 'open', channel: 'whatsapp' };
      const select = makeSelectQueue([[{ id: 'canon_1' }], [existing]]);
      const insert = vi.fn();
      const service = new ConversationService({ client: { select, insert } } as unknown as DatabaseService);

      const result = await service.startConversation('ws_1', 'canon_1', { channel: 'whatsapp' });

      expect(result).toEqual(existing);
      expect(insert).not.toHaveBeenCalled();
    });

    it('creates a new conversation when no open one exists on this channel', async () => {
      const created = { id: 'conv_2', status: 'open', channel: 'whatsapp' };
      const select = makeSelectQueue([[{ id: 'canon_1' }], []]);
      const insert = vi.fn(() => makeInsertChain(created));
      const service = new ConversationService({ client: { select, insert } } as unknown as DatabaseService);

      const result = await service.startConversation('ws_1', 'canon_1', { channel: 'whatsapp' });

      expect(result).toEqual(created);
    });
  });

  describe('sendMessage()', () => {
    it('throws NotFoundError when the conversation does not exist for this customer', async () => {
      const select = makeSelectQueue([[]]);
      const service = new ConversationService({ client: { select } } as unknown as DatabaseService);

      await expect(service.sendMessage('ws_1', 'canon_1', 'conv_missing', 'hi')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('inserts an outbound human message with pending delivery state and touches the conversation', async () => {
      const message = { id: 'msg_1', direction: 'outbound', senderType: 'human', content: 'hi', deliveryState: 'pending' };
      const select = makeSelectQueue([[{ id: 'conv_1' }]]);
      const insert = vi.fn(() => makeInsertChain(message));
      const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) }));
      const service = new ConversationService({ client: { select, insert, update } } as unknown as DatabaseService);

      const result = await service.sendMessage('ws_1', 'canon_1', 'conv_1', 'hi');

      expect(result).toEqual(message);
      expect(insert).toHaveBeenCalledWith(
        expect.anything(),
      );
      expect(update).toHaveBeenCalled();
    });
  });

  describe('listConversations()', () => {
    it('throws NotFoundError when the canonical customer does not exist in this workspace', async () => {
      const select = makeSelectQueue([[]]);
      const service = new ConversationService({ client: { select } } as unknown as DatabaseService);

      await expect(service.listConversations('ws_1', 'canon_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns whatever the query yields', async () => {
      const rows = [{ id: 'conv_1' }];
      const select = makeSelectQueue([[{ id: 'canon_1' }], rows]);
      const service = new ConversationService({ client: { select } } as unknown as DatabaseService);

      const result = await service.listConversations('ws_1', 'canon_1');

      expect(result).toEqual(rows);
    });
  });

  describe('listMessages()', () => {
    it('throws NotFoundError when the conversation does not exist for this customer', async () => {
      const select = makeSelectQueue([[]]);
      const service = new ConversationService({ client: { select } } as unknown as DatabaseService);

      await expect(service.listMessages('ws_1', 'canon_1', 'conv_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns messages oldest-first', async () => {
      const rows = [{ id: 'msg_1' }, { id: 'msg_2' }];
      const select = makeSelectQueue([[{ id: 'conv_1' }], rows]);
      const service = new ConversationService({ client: { select } } as unknown as DatabaseService);

      const result = await service.listMessages('ws_1', 'canon_1', 'conv_1');

      expect(result).toEqual(rows);
    });
  });
});
