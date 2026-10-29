import { describe, expect, it, vi } from 'vitest';
import { IdentityResolutionService, REVIEW_SIGNAL_CONFIDENCE } from './identity-resolution.service';
import { RequestContext } from '../../common/logging/request-context';
import type { DatabaseService } from '../../database/database.service';

function makeSelectChain(result: unknown) {
  const chain: Record<string, unknown> = {
    from: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => result),
    then: (resolve: (value: unknown) => void) => resolve(result),
  };
  return chain;
}

function makeInsertChain(returned: { id: string; mergedIntoId?: string | null }) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    returning: vi.fn(async () => [returned]),
  };
  return chain;
}

function makeUpdateChain() {
  const chain: Record<string, unknown> = {
    set: vi.fn(() => chain),
    where: vi.fn(async () => undefined),
  };
  return chain;
}

function makeDuplicateInsertChain() {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(async () => undefined),
  };
  return chain;
}

describe('IdentityResolutionService', () => {
  describe('resolveMany()', () => {
    it('does nothing for an empty batch', async () => {
      const client = { select: vi.fn(), insert: vi.fn(), update: vi.fn() };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', []);

      expect(client.select).not.toHaveBeenCalled();
    });

    it('does nothing when every matched row is already resolved', async () => {
      const select = vi.fn(() => makeSelectChain([]));
      const client = { select, insert: vi.fn(), update: vi.fn() };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1']);

      expect(select).toHaveBeenCalledTimes(1);
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('creates a new canonical customer for an unresolved row with an email, and links it', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'cc_1', email: 'A@Example.com' }]));
      const insertChain = makeInsertChain({ id: 'canon_1' });
      const updateChain = makeUpdateChain();
      const client = { select, insert: vi.fn(() => insertChain), update: vi.fn(() => updateChain) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1']);

      expect(insertChain.values).toHaveBeenCalledWith({ workspaceId: 'ws_1', primaryEmail: 'a@example.com' });
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ canonicalCustomerId: 'canon_1' }));
    });

    it('resolves a null-email row to its own canonical customer', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'cc_2', email: null }]));
      const insertChain = makeInsertChain({ id: 'canon_2' });
      const updateChain = makeUpdateChain();
      const client = { select, insert: vi.fn(() => insertChain), update: vi.fn(() => updateChain) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['2']);

      expect(insertChain.values).toHaveBeenCalledWith({ workspaceId: 'ws_1', primaryEmail: null });
      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ canonicalCustomerId: 'canon_2' }));
    });

    it('links two unresolved rows with the same email (case-insensitive) to the same canonical customer', async () => {
      const select = vi.fn(() =>
        makeSelectChain([
          { id: 'cc_1', email: 'a@example.com' },
          { id: 'cc_2', email: 'A@EXAMPLE.COM' },
        ]),
      );
      // The second insert hits the unique-index conflict and onConflictDoUpdate returns the same existing row.
      const insertChain = makeInsertChain({ id: 'canon_1' });
      const updateChain = makeUpdateChain();
      const client = { select, insert: vi.fn(() => insertChain), update: vi.fn(() => updateChain) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1', '2']);

      const setCalls = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls;
      expect(setCalls[0][0]).toMatchObject({ canonicalCustomerId: 'canon_1' });
      expect(setCalls[1][0]).toMatchObject({ canonicalCustomerId: 'canon_1' });
    });

    it('flags a pending duplicate when the resolved row shares an E.164 phone with a different, already-linked canonical customer', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'cc_2', email: 'b@example.com', phoneE164: '+14155552671', canonicalCustomerId: null }]));
      const selectDistinct = vi.fn(() =>
        makeSelectChain([
          { phoneE164: '+14155552671', canonicalCustomerId: 'canon_1' },
          { phoneE164: '+14155552671', canonicalCustomerId: 'canon_2' },
        ]),
      );
      const insertChain = makeInsertChain({ id: 'canon_2' });
      const duplicateInsertChain = makeDuplicateInsertChain();
      const updateChain = makeUpdateChain();
      const insert = vi.fn().mockReturnValueOnce(insertChain).mockReturnValueOnce(duplicateInsertChain);
      const client = { select, selectDistinct, insert, update: vi.fn(() => updateChain) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['2']);

      expect(selectDistinct).toHaveBeenCalledTimes(1);
      expect(duplicateInsertChain.values).toHaveBeenCalledWith([
        { workspaceId: 'ws_1', canonicalCustomerAId: 'canon_1', canonicalCustomerBId: 'canon_2', matchedSignal: 'phone', confidence: 'medium', matchedValue: '+14155552671' },
      ]);
    });

    it('checks phone duplicates for an already-linked row too (phone changed on a later sync), without re-resolving it', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'cc_2', email: 'b@example.com', phoneE164: '+14155552671', canonicalCustomerId: 'canon_2' }]));
      const selectDistinct = vi.fn(() =>
        makeSelectChain([
          { phoneE164: '+14155552671', canonicalCustomerId: 'canon_2' },
          { phoneE164: '+14155552671', canonicalCustomerId: 'canon_1' },
        ]),
      );
      const duplicateInsertChain = makeDuplicateInsertChain();
      const insert = vi.fn(() => duplicateInsertChain);
      const update = vi.fn();
      const client = { select, selectDistinct, insert, update };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['2']);

      expect(update).not.toHaveBeenCalled();
      expect(insert).toHaveBeenCalledTimes(1);
      expect(duplicateInsertChain.values).toHaveBeenCalledWith([
        { workspaceId: 'ws_1', canonicalCustomerAId: 'canon_1', canonicalCustomerBId: 'canon_2', matchedSignal: 'phone', confidence: 'medium', matchedValue: '+14155552671' },
      ]);
    });

    it('never pairs a canonical customer with itself (two source rows of the same customer sharing a phone)', async () => {
      const select = vi.fn(() =>
        makeSelectChain([
          { id: 'cc_1', email: 'a@example.com', phoneE164: '+14155552671', canonicalCustomerId: 'canon_1' },
          { id: 'cc_2', email: 'a@example.com', phoneE164: '+14155552671', canonicalCustomerId: 'canon_1' },
        ]),
      );
      const selectDistinct = vi.fn(() => makeSelectChain([{ phoneE164: '+14155552671', canonicalCustomerId: 'canon_1' }]));
      const insert = vi.fn();
      const client = { select, selectDistinct, insert, update: vi.fn() };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1', '2']);

      expect(insert).not.toHaveBeenCalled();
    });

    it('does not check for phone duplicates when the row has no (normalizable) phone', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'cc_1', email: 'a@example.com', phoneE164: null }]));
      const selectDistinct = vi.fn();
      const insertChain = makeInsertChain({ id: 'canon_1' });
      const client = { select, selectDistinct, insert: vi.fn(() => insertChain), update: vi.fn(() => makeUpdateChain()) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1']);

      expect(selectDistinct).not.toHaveBeenCalled();
    });

    it('does not flag a duplicate when no other canonical customer shares the phone', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'cc_1', email: 'a@example.com', phoneE164: '+14155552671' }]));
      const selectDistinct = vi.fn(() => makeSelectChain([]));
      const insertChain = makeInsertChain({ id: 'canon_1' });
      const insert = vi.fn().mockReturnValueOnce(insertChain);
      const client = { select, selectDistinct, insert, update: vi.fn(() => makeUpdateChain()) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1']);

      expect(insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveWebsiteVisitor() — anonymous → known linking (Part 3)', () => {
    it('links an unlinked visitor to the EXISTING canonical customer with that (normalized) email', async () => {
      const visitorSelect = makeSelectChain([{ id: 'visitor_1', canonicalCustomerId: null }]);
      const canonicalSelect = makeSelectChain([{ id: 'canon_existing_from_shopify' }]);
      const select = vi.fn().mockReturnValueOnce(visitorSelect).mockReturnValueOnce(canonicalSelect);
      const insert = vi.fn();
      const updateChain = makeUpdateChain();
      const client = { select, insert, update: vi.fn(() => updateChain) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveWebsiteVisitor('ws_1', 'visitor_1', ' Shopper@Example.com ');

      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ canonicalCustomerId: 'canon_existing_from_shopify' }));
      expect(insert).not.toHaveBeenCalled();
    });

    it('never creates a canonical customer: an unknown email leaves the visitor anonymous', async () => {
      const select = vi
        .fn()
        .mockReturnValueOnce(makeSelectChain([{ id: 'visitor_1', canonicalCustomerId: null }]))
        .mockReturnValueOnce(makeSelectChain([]));
      const insert = vi.fn();
      const update = vi.fn();
      const service = new IdentityResolutionService({ client: { select, insert, update } } as unknown as DatabaseService);

      await service.resolveWebsiteVisitor('ws_1', 'visitor_1', 'nobody@example.com');

      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('does nothing when the visitor does not exist in this workspace (tenant isolation)', async () => {
      const select = vi.fn(() => makeSelectChain([]));
      const insert = vi.fn();
      const update = vi.fn();
      const client = { select, insert, update };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveWebsiteVisitor('ws_1', 'visitor_from_another_workspace', 'shopper@example.com');

      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('does nothing when the visitor is already linked — no re-link, even to a different email (idempotent, no conflicting overwrite)', async () => {
      const select = vi
        .fn()
        .mockReturnValueOnce(makeSelectChain([{ id: 'visitor_1', canonicalCustomerId: 'canon_already_linked' }]))
        .mockReturnValueOnce(makeSelectChain([]));
      const insert = vi.fn();
      const update = vi.fn();
      const client = { select, insert, update };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveWebsiteVisitor('ws_1', 'visitor_1', 'a-different-email@example.com');

      expect(insert).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('is idempotent across repeated calls with the same signal: the second call is a no-op once linked', async () => {
      const updateChain = makeUpdateChain();
      const update = vi.fn(() => updateChain);

      const select = vi
        .fn()
        .mockReturnValueOnce(makeSelectChain([{ id: 'visitor_1', canonicalCustomerId: null }]))
        .mockReturnValueOnce(makeSelectChain([{ id: 'canon_1' }]))
        .mockReturnValueOnce(makeSelectChain([{ id: 'visitor_1', canonicalCustomerId: 'canon_1' }]))
        .mockReturnValueOnce(makeSelectChain([{ id: 'canon_1', primaryEmail: 'shopper@example.com', mergedIntoId: null }]));
      const client = { select, insert: vi.fn(), update };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveWebsiteVisitor('ws_1', 'visitor_1', 'shopper@example.com');
      await service.resolveWebsiteVisitor('ws_1', 'visitor_1', 'shopper@example.com');

      expect(client.insert).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1);
    });
  });

  describe('confidence, merge-following and conflicts', () => {
    it('maps every review signal to its Phase 1 confidence: phone medium, conflicts high', () => {
      expect(REVIEW_SIGNAL_CONFIDENCE).toEqual({ phone: 'medium', email_conflict: 'high', website_email_conflict: 'high' });
    });

    it('links a new source row whose email matches a merged customer to the survivor, never the merged row', async () => {
      const select = vi.fn(() => makeSelectChain([{ id: 'cc_9', email: 'merged@example.com', canonicalCustomerId: null }]));
      const insertChain = makeInsertChain({ id: 'canon_merged', mergedIntoId: 'canon_survivor' });
      const updateChain = makeUpdateChain();
      const client = { select, insert: vi.fn(() => insertChain), update: vi.fn(() => updateChain) };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['9']);

      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ canonicalCustomerId: 'canon_survivor' }));
    });

    it('records an email_conflict (high) when an already-linked row’s email now belongs to another customer, without re-linking', async () => {
      const select = vi
        .fn()
        .mockReturnValueOnce(makeSelectChain([{ id: 'cc_1', email: ' New@Example.com ', phoneE164: null, canonicalCustomerId: 'canon_a', canonicalEmail: 'old@example.com' }]))
        .mockReturnValueOnce(makeSelectChain([{ id: 'canon_b', primaryEmail: 'new@example.com', mergedIntoId: null }]));
      const duplicateInsertChain = makeDuplicateInsertChain();
      const insert = vi.fn(() => duplicateInsertChain);
      const update = vi.fn();
      const service = new IdentityResolutionService({ client: { select, insert, update } } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1']);

      expect(update).not.toHaveBeenCalled();
      expect(duplicateInsertChain.values).toHaveBeenCalledWith([
        { workspaceId: 'ws_1', canonicalCustomerAId: 'canon_a', canonicalCustomerBId: 'canon_b', matchedSignal: 'email_conflict', confidence: 'high', matchedValue: 'new@example.com' },
      ]);
    });

    it('records no conflict when the changed email belongs to no customer, or to the same (merged-into) customer', async () => {
      const select = vi
        .fn()
        .mockReturnValueOnce(
          makeSelectChain([
            { id: 'cc_1', email: 'nobody@example.com', phoneE164: null, canonicalCustomerId: 'canon_a', canonicalEmail: 'a@example.com' },
            { id: 'cc_2', email: 'alias@example.com', phoneE164: null, canonicalCustomerId: 'canon_a', canonicalEmail: 'a@example.com' },
          ]),
        )
        .mockReturnValueOnce(makeSelectChain([{ id: 'canon_merged', primaryEmail: 'alias@example.com', mergedIntoId: 'canon_a' }]));
      const insert = vi.fn();
      const service = new IdentityResolutionService({ client: { select, insert, update: vi.fn() } } as unknown as DatabaseService);

      await service.resolveMany('ws_1', 'shopify', ['1', '2']);

      expect(insert).not.toHaveBeenCalled();
    });

    it('records a website_email_conflict (high) when a linked visitor’s verified email belongs to another customer, keeping the link', async () => {
      const select = vi
        .fn()
        .mockReturnValueOnce(makeSelectChain([{ id: 'visitor_1', canonicalCustomerId: 'canon_b' }]))
        .mockReturnValueOnce(makeSelectChain([{ id: 'canon_a', primaryEmail: 'other@example.com', mergedIntoId: null }]));
      const duplicateInsertChain = makeDuplicateInsertChain();
      const insert = vi.fn(() => duplicateInsertChain);
      const update = vi.fn();
      const service = new IdentityResolutionService({ client: { select, insert, update } } as unknown as DatabaseService);

      await service.resolveWebsiteVisitor('ws_1', 'visitor_1', 'Other@Example.com');

      expect(update).not.toHaveBeenCalled();
      expect(duplicateInsertChain.values).toHaveBeenCalledWith([
        { workspaceId: 'ws_1', canonicalCustomerAId: 'canon_a', canonicalCustomerBId: 'canon_b', matchedSignal: 'website_email_conflict', confidence: 'high', matchedValue: 'other@example.com' },
      ]);
    });

    it('links an unlinked visitor whose email matches a merged customer to the survivor', async () => {
      const select = vi
        .fn()
        .mockReturnValueOnce(makeSelectChain([{ id: 'visitor_1', canonicalCustomerId: null }]))
        .mockReturnValueOnce(makeSelectChain([{ id: 'canon_merged', mergedIntoId: 'canon_survivor' }]));
      const updateChain = makeUpdateChain();
      const service = new IdentityResolutionService({ client: { select, insert: vi.fn(), update: vi.fn(() => updateChain) } } as unknown as DatabaseService);

      await service.resolveWebsiteVisitor('ws_1', 'visitor_1', 'merged@example.com');

      expect(updateChain.set).toHaveBeenCalledWith(expect.objectContaining({ canonicalCustomerId: 'canon_survivor' }));
    });
  });

  describe('dismiss()', () => {
    const DUP_ID = '11111111-1111-4111-8111-111111111111';
    const asAdmin = <T>(fn: () => Promise<T>) => RequestContext.run({ correlationId: 'c', workspaceId: 'ws_1', actorUserId: 'user_admin', actorRole: 'admin' }, fn);

    function makeReturningUpdateChain(returned: unknown[]) {
      const chain: Record<string, unknown> = {
        set: vi.fn(() => chain),
        where: vi.fn(() => chain),
        returning: vi.fn(async () => returned),
      };
      return chain;
    }

    it('marks a pending candidate dismissed with who/when, scoped to workspace + pending status', async () => {
      const dismissed = { id: DUP_ID, status: 'dismissed', confidence: 'medium', matchedSignal: 'phone' };
      const updateChain = makeReturningUpdateChain([dismissed]);
      const service = new IdentityResolutionService({ client: { update: vi.fn(() => updateChain), select: vi.fn() } } as unknown as DatabaseService);

      const result = await asAdmin(() => service.dismiss('ws_1', DUP_ID));

      expect(result).toEqual(dismissed);
      expect(updateChain.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'dismissed', reviewedByUserId: 'user_admin', reviewedAt: expect.any(Date) }),
      );
      const setArg = (updateChain.set as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
      expect(setArg).not.toHaveProperty('confidence');
      expect(setArg).not.toHaveProperty('matchedValue');
    });

    it('409s when the candidate was already reviewed, 404s when it is unknown/another workspace’s or not a uuid', async () => {
      const select = vi.fn().mockReturnValueOnce(makeSelectChain([{ id: DUP_ID }])).mockReturnValueOnce(makeSelectChain([]));
      const update = vi.fn(() => makeReturningUpdateChain([]));
      const service = new IdentityResolutionService({ client: { update, select } } as unknown as DatabaseService);

      await expect(asAdmin(() => service.dismiss('ws_1', DUP_ID))).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(asAdmin(() => service.dismiss('ws_1', DUP_ID))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(asAdmin(() => service.dismiss('ws_1', 'not-a-uuid'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(update).toHaveBeenCalledTimes(2);
    });

    it('refuses without an authenticated actor', async () => {
      const service = new IdentityResolutionService({ client: { update: vi.fn(), select: vi.fn() } } as unknown as DatabaseService);

      await expect(service.dismiss('ws_1', DUP_ID)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    });
  });

  describe('merge() — input checks before any DB work', () => {
    const DUP_ID = '11111111-1111-4111-8111-111111111111';
    const asAdmin = <T>(fn: () => Promise<T>) => RequestContext.run({ correlationId: 'c', workspaceId: 'ws_1', actorUserId: 'user_admin', actorRole: 'admin' }, fn);
    const makeService = () => {
      const transaction = vi.fn();
      return { service: new IdentityResolutionService({ transaction } as unknown as DatabaseService), transaction };
    };

    it('refuses without an authenticated actor', async () => {
      const { service, transaction } = makeService();
      await expect(service.merge('ws_1', DUP_ID)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(transaction).not.toHaveBeenCalled();
    });

    it('404s a non-uuid candidate id and 400s an over-long reason', async () => {
      const { service, transaction } = makeService();
      await expect(asAdmin(() => service.merge('ws_1', 'nope'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(asAdmin(() => service.merge('ws_1', DUP_ID, 'x'.repeat(501)))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  describe('listDuplicates()', () => {
    it('returns pending duplicate candidates for the workspace', async () => {
      const rows = [{ id: 'dup_1', canonicalCustomerAId: 'canon_1', canonicalCustomerBId: 'canon_2', status: 'pending' }];
      const select = vi.fn(() => makeSelectChain(rows));
      const client = { select };
      const service = new IdentityResolutionService({ client } as unknown as DatabaseService);

      const result = await service.listDuplicates('ws_1');

      expect(result).toEqual(rows);
    });
  });
});
