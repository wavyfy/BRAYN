import { describe, expect, it, vi } from 'vitest';
import { ConversationService } from './conversation.service';
import type { DatabaseService } from '../../database/database.service';
import type { CustomerIntelligenceService } from '../customer-intelligence/customer-intelligence.service';
import { NotFoundError } from '../../common/errors/app-error';

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

function makeService(client: Record<string, unknown>, requireCanonical = vi.fn(async () => ({ id: 'canon_1', primaryEmail: null }))) {
  const service = new ConversationService(
    { client } as unknown as DatabaseService,
    { requireCanonical } as unknown as CustomerIntelligenceService,
  );
  return { service, requireCanonical };
}

const notFound = () => vi.fn(async () => Promise.reject(new NotFoundError('No customer with that id exists in this workspace.')));
const merged = () =>
  vi.fn(async () => Promise.reject(new NotFoundError('This customer was merged into another customer.', { mergedIntoId: 'canon_survivor' })));

describe('ConversationService', () => {
  describe('startConversation()', () => {
    it('resolves the customer through the UCIR (workspace-scoped) before touching conversations', async () => {
      const select = makeSelectQueue([[]]);
      const insert = vi.fn(() => makeInsertChain({ id: 'conv_1' }));
      const { service, requireCanonical } = makeService({ select, insert });

      await service.startConversation('ws_1', 'canon_1', { channel: 'whatsapp' });

      expect(requireCanonical).toHaveBeenCalledWith('ws_1', 'canon_1');
    });

    it('throws NotFoundError and creates nothing when the customer is unknown or in another workspace', async () => {
      const select = vi.fn();
      const insert = vi.fn();
      const { service } = makeService({ select, insert }, notFound());

      await expect(service.startConversation('ws_other', 'canon_1', { channel: 'whatsapp' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(select).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    });

    it('rejects a merged customer with NOT_FOUND + mergedIntoId and creates nothing', async () => {
      const select = vi.fn();
      const insert = vi.fn();
      const { service } = makeService({ select, insert }, merged());

      await expect(service.startConversation('ws_1', 'canon_merged', { channel: 'whatsapp' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        details: { mergedIntoId: 'canon_survivor' },
      });
      expect(select).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
    });

    it('returns the existing open conversation on this channel instead of creating a duplicate', async () => {
      const existing = { id: 'conv_1', status: 'open', channel: 'whatsapp' };
      const select = makeSelectQueue([[existing]]);
      const insert = vi.fn();
      const service = makeService({ select, insert }).service;

      const result = await service.startConversation('ws_1', 'canon_1', { channel: 'whatsapp' });

      expect(result).toEqual(existing);
      expect(insert).not.toHaveBeenCalled();
    });

    it('creates a new conversation when no open one exists on this channel', async () => {
      const created = { id: 'conv_2', status: 'open', channel: 'whatsapp' };
      const select = makeSelectQueue([[]]);
      const insert = vi.fn(() => makeInsertChain(created));
      const service = makeService({ select, insert }).service;

      const result = await service.startConversation('ws_1', 'canon_1', { channel: 'whatsapp' });

      expect(result).toEqual(created);
    });
  });

  describe('sendMessage()', () => {
    it('throws NotFoundError when the conversation does not exist for this customer', async () => {
      const select = makeSelectQueue([[]]);
      const service = makeService({ select }).service;

      await expect(service.sendMessage('ws_1', 'canon_1', 'conv_missing', 'hi')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('inserts an outbound human message with pending delivery state and touches the conversation', async () => {
      const message = { id: 'msg_1', direction: 'outbound', senderType: 'human', content: 'hi', deliveryState: 'pending' };
      const select = makeSelectQueue([[{ id: 'conv_1' }]]);
      const insert = vi.fn(() => makeInsertChain(message));
      const update = vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) }));
      const service = makeService({ select, insert, update }).service;

      const result = await service.sendMessage('ws_1', 'canon_1', 'conv_1', 'hi');

      expect(result).toEqual(message);
      expect(insert).toHaveBeenCalledWith(
        expect.anything(),
      );
      expect(update).toHaveBeenCalled();
    });
  });

  describe('listConversations()', () => {
    it('throws NotFoundError when the customer is unknown or in another workspace', async () => {
      const select = vi.fn();
      const { service, requireCanonical } = makeService({ select }, notFound());

      await expect(service.listConversations('ws_other', 'canon_1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(requireCanonical).toHaveBeenCalledWith('ws_other', 'canon_1');
      expect(select).not.toHaveBeenCalled();
    });

    it('rejects a merged customer with NOT_FOUND + mergedIntoId instead of listing its conversations', async () => {
      const select = vi.fn();
      const { service } = makeService({ select }, merged());

      await expect(service.listConversations('ws_1', 'canon_merged')).rejects.toMatchObject({
        code: 'NOT_FOUND',
        details: { mergedIntoId: 'canon_survivor' },
      });
      expect(select).not.toHaveBeenCalled();
    });

    it('returns whatever the query yields', async () => {
      const rows = [{ id: 'conv_1' }];
      const select = makeSelectQueue([rows]);
      const service = makeService({ select }).service;

      const result = await service.listConversations('ws_1', 'canon_1');

      expect(result).toEqual(rows);
    });
  });

  describe('listMessages()', () => {
    it('throws NotFoundError when the conversation does not exist for this customer', async () => {
      const select = makeSelectQueue([[]]);
      const service = makeService({ select }).service;

      await expect(service.listMessages('ws_1', 'canon_1', 'conv_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns messages oldest-first', async () => {
      const rows = [{ id: 'msg_1' }, { id: 'msg_2' }];
      const select = makeSelectQueue([[{ id: 'conv_1' }], rows]);
      const service = makeService({ select }).service;

      const result = await service.listMessages('ws_1', 'canon_1', 'conv_1');

      expect(result).toEqual(rows);
    });
  });
});
