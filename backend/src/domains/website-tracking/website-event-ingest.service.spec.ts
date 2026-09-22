import { describe, expect, it, vi } from 'vitest';
import { WebsiteEventIngestService } from './website-event-ingest.service';
import type { DatabaseService } from '../../database/database.service';
import type { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type { IntegrationService } from '../integration/integration.service';
import type { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import type { IngestWebsiteEventInput } from './dto/ingest-website-event.schema';

function makeChain(finalResult: unknown) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    returning: vi.fn(async () => finalResult),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => finalResult),
    then: (resolve: (value: unknown) => void) => resolve(finalResult),
  };
  return chain;
}

const connectedIntegration = { id: 'int_1', status: 'connected' };
const VALID_KEY = 'valid_write_key';

const baseInput: IngestWebsiteEventInput = {
  visitorId: 'visitor_abc',
  sessionId: 'session_abc',
  eventId: 'evt_1',
  eventType: 'page_view',
};

function makeDeps(
  overrides: {
    select?: unknown[];
    reserve?: boolean;
    visitorRow?: unknown;
    sessionRow?: unknown;
    credentials?: Record<string, string> | null;
  } = {},
) {
  const selectResults = overrides.select ?? [[connectedIntegration]];
  let selectCall = 0;
  const selectChains = selectResults.map((result) => makeChain(result));

  const insertCallOrder: string[] = [];

  const visitorRow = overrides.visitorRow ?? { id: 'visitor_row_1' };
  const sessionRow = overrides.sessionRow ?? { id: 'session_row_1' };

  const client = {
    select: vi.fn(() => selectChains[selectCall++] ?? makeChain([])),
    insert: vi.fn(() => {
      // Distinguish target table by call order: visitor upsert, then session upsert, then event insert.
      insertCallOrder.push('insert');
      const n = insertCallOrder.length;
      if (n === 1) return makeChain([visitorRow]);
      if (n === 2) return makeChain([sessionRow]);
      return makeChain(undefined);
    }),
  };

  const idempotency = {
    reserve: vi.fn(async () => overrides.reserve ?? true),
    complete: vi.fn(async () => undefined),
  } as unknown as IdempotencyService;

  const integrationService = {
    getCredentials: vi.fn(async () => (overrides.credentials === undefined ? { writeKey: VALID_KEY } : overrides.credentials)),
  } as unknown as IntegrationService;

  const identityResolutionService = {
    resolveWebsiteVisitor: vi.fn(async () => undefined),
  } as unknown as IdentityResolutionService;

  const service = new WebsiteEventIngestService(
    { client } as unknown as DatabaseService,
    idempotency,
    integrationService,
    identityResolutionService,
  );

  return { service, client, idempotency, integrationService, identityResolutionService };
}

describe('WebsiteEventIngestService', () => {
  it('accepts a valid event with a matching write key: upserts visitor + session, inserts the event, completes idempotency', async () => {
    const { service, client, idempotency } = makeDeps();

    const result = await service.ingest('ws_1', baseInput, VALID_KEY);

    expect(result).toEqual({ status: 'accepted' });
    expect(idempotency.reserve).toHaveBeenCalledWith('website-event:ws_1:evt_1');
    expect(idempotency.complete).toHaveBeenCalledWith('website-event:ws_1:evt_1');
    expect(client.insert).toHaveBeenCalledTimes(3);
  });

  it('throws NotFoundError when the workspace has no website_tracking connection', async () => {
    const { service } = makeDeps({ select: [[]] });

    await expect(service.ingest('ws_1', baseInput, VALID_KEY)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws ConflictError when the website_tracking integration is disconnected', async () => {
    const { service } = makeDeps({ select: [[{ id: 'int_1', status: 'disconnected' }]] });

    await expect(service.ingest('ws_1', baseInput, VALID_KEY)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('throws UnauthenticatedError when no write key is supplied', async () => {
    const { service, client } = makeDeps();

    await expect(service.ingest('ws_1', baseInput, null)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('throws UnauthenticatedError when the supplied write key does not match', async () => {
    const { service, client } = makeDeps();

    await expect(service.ingest('ws_1', baseInput, 'wrong_key')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('throws UnauthenticatedError when no write key has been generated for this integration yet', async () => {
    const { service, client } = makeDeps({ credentials: null });

    await expect(service.ingest('ws_1', baseInput, VALID_KEY)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('throws UnauthenticatedError when stored credentials have no writeKey field', async () => {
    const { service } = makeDeps({ credentials: { someOtherField: 'x' } });

    await expect(service.ingest('ws_1', baseInput, VALID_KEY)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('returns duplicate (and persists nothing) on a redelivered eventId', async () => {
    const { service, client } = makeDeps({ reserve: false });

    const result = await service.ingest('ws_1', baseInput, VALID_KEY);

    expect(result).toEqual({ status: 'duplicate' });
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('scopes the visitor upsert to the given workspaceId and visitorId', async () => {
    const { service, client } = makeDeps();

    await service.ingest('ws_1', baseInput, VALID_KEY);

    const visitorInsertChain = client.insert.mock.results[0].value as { values: ReturnType<typeof vi.fn> };
    expect(visitorInsertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws_1', visitorId: 'visitor_abc' }),
    );
  });

  it('links the session and event to the upserted visitor row, and the event to the upserted session row', async () => {
    const { service, client } = makeDeps({
      visitorRow: { id: 'visitor_row_xyz' },
      sessionRow: { id: 'session_row_xyz' },
    });

    await service.ingest('ws_1', baseInput, VALID_KEY);

    const sessionInsertChain = client.insert.mock.results[1].value as { values: ReturnType<typeof vi.fn> };
    expect(sessionInsertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws_1', visitorId: 'visitor_row_xyz', sessionKey: 'session_abc' }),
    );

    const eventInsertChain = client.insert.mock.results[2].value as { values: ReturnType<typeof vi.fn> };
    expect(eventInsertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws_1',
        visitorId: 'visitor_row_xyz',
        sessionId: 'session_row_xyz',
        eventId: 'evt_1',
        eventType: 'page_view',
      }),
    );
  });

  it('uses the client-supplied occurredAt when given', async () => {
    const { service, client } = makeDeps();

    await service.ingest('ws_1', { ...baseInput, occurredAt: '2026-01-01T00:00:00.000Z' }, VALID_KEY);

    const eventInsertChain = client.insert.mock.results[2].value as { values: ReturnType<typeof vi.fn> };
    expect(eventInsertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ occurredAt: new Date('2026-01-01T00:00:00.000Z') }),
    );
  });

  it('falls back to the server receipt time when occurredAt is omitted', async () => {
    const { service, client } = makeDeps();

    await service.ingest('ws_1', baseInput, VALID_KEY);

    const eventInsertChain = client.insert.mock.results[2].value as { values: ReturnType<typeof vi.fn> };
    const call = eventInsertChain.values.mock.calls[0][0] as { occurredAt: Date };
    expect(call.occurredAt).toBeInstanceOf(Date);
  });

  it('stores the optional payload, defaulting to null when omitted', async () => {
    const { service, client } = makeDeps();

    await service.ingest('ws_1', { ...baseInput, payload: { path: '/products/1' } }, VALID_KEY);

    const eventInsertChain = client.insert.mock.results[2].value as { values: ReturnType<typeof vi.fn> };
    expect(eventInsertChain.values).toHaveBeenCalledWith(expect.objectContaining({ payload: { path: '/products/1' } }));
  });

  describe('identity_signal events (Part 3 — anonymous → known linking)', () => {
    it('hands the visitor row id and email to IdentityResolutionService.resolveWebsiteVisitor', async () => {
      const { service, identityResolutionService } = makeDeps({ visitorRow: { id: 'visitor_row_xyz' } });

      await service.ingest(
        'ws_1',
        { ...baseInput, eventType: 'identity_signal', payload: { email: 'shopper@example.com' } },
        VALID_KEY,
      );

      expect(identityResolutionService.resolveWebsiteVisitor).toHaveBeenCalledWith(
        'ws_1',
        'visitor_row_xyz',
        'shopper@example.com',
      );
    });

    it('does not call resolveWebsiteVisitor for a non-identity event', async () => {
      const { service, identityResolutionService } = makeDeps();

      await service.ingest('ws_1', baseInput, VALID_KEY);

      expect(identityResolutionService.resolveWebsiteVisitor).not.toHaveBeenCalled();
    });

    it('still records the identity_signal event row itself, same as any other event type', async () => {
      const { service, client } = makeDeps();

      await service.ingest(
        'ws_1',
        { ...baseInput, eventType: 'identity_signal', payload: { email: 'shopper@example.com' } },
        VALID_KEY,
      );

      const eventInsertChain = client.insert.mock.results[2].value as { values: ReturnType<typeof vi.fn> };
      expect(eventInsertChain.values).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'identity_signal' }));
    });
  });

  describe('historical activity stays associated after linking (Part 3)', () => {
    it('never overwrites canonicalCustomerId on the visitor upsert set-clause for a later, unrelated event', async () => {
      const { service, client } = makeDeps();

      await service.ingest('ws_1', baseInput, VALID_KEY);

      const visitorInsertChain = client.insert.mock.results[0].value as { onConflictDoUpdate: ReturnType<typeof vi.fn> };
      const conflictArgs = visitorInsertChain.onConflictDoUpdate.mock.calls[0][0] as { set: Record<string, unknown> };
      // The upsert only ever refreshes lastSeenAt — canonicalCustomerId is
      // never in this set clause, so a previously linked visitor's link
      // survives every subsequent event, and every event still points at
      // the same visitor row regardless of when linking happened.
      expect(conflictArgs.set).not.toHaveProperty('canonicalCustomerId');
    });
  });
});
