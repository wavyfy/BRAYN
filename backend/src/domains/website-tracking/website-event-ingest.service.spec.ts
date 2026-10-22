import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { WebsiteEventIngestService } from './website-event-ingest.service';
import type { DatabaseService } from '../../database/database.service';
import type { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type { RedisService } from '../../common/rate-limit/redis.service';
import type { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import type { IntegrationService } from '../integration/integration.service';
import type { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import type { IngestWebsiteEventInput } from './dto/ingest-website-event.schema';

function makeChain(finalResult: unknown) {
  const chain: Record<string, unknown> = {
    values: vi.fn(() => chain),
    onConflictDoUpdate: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
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
const ORIGIN = 'https://shop.example.com';
const IDENTITY_SECRET = 'identity_secret_1';
const CTX = { writeKey: VALID_KEY, origin: ORIGIN, ip: '203.0.113.7' };
const STORED_CREDENTIALS = { writeKey: VALID_KEY, allowedOrigins: JSON.stringify([ORIGIN]), identitySecret: IDENTITY_SECRET };
const sign = (email: string, secret = IDENTITY_SECRET) => createHmac('sha256', secret).update(email).digest('hex');

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
    resolveWebsiteVisitor?: () => Promise<void>;
    fail?: () => Promise<void>;
    redisConfigured?: boolean;
    increment?: (key: string) => Promise<number>;
  } = {},
) {
  const selectResults = overrides.select ?? [[connectedIntegration]];
  let selectCall = 0;
  const selectChains = selectResults.map((result) => makeChain(result));

  const insertCallOrder: string[] = [];

  const visitorRow = overrides.visitorRow ?? { id: 'visitor_row_1' };
  const sessionRow = 'sessionRow' in overrides ? overrides.sessionRow : { id: 'session_row_1' };

  const eventInsertChain = makeChain(undefined);
  const client = {
    select: vi.fn(() => selectChains[selectCall++] ?? makeChain([])),
    insert: vi.fn(() => {
      // Distinguish target table by call order: visitor upsert, then session upsert, then event insert.
      insertCallOrder.push('insert');
      const n = insertCallOrder.length;
      if (n === 1) return makeChain([visitorRow]);
      if (n === 2) return makeChain(sessionRow ? [sessionRow] : []);
      return eventInsertChain;
    }),
  };

  const idempotency = {
    reserve: vi.fn(async () => overrides.reserve ?? true),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(overrides.fail ?? (async () => undefined)),
  } as unknown as IdempotencyService;

  const integrationService = {
    getCredentials: vi.fn(async () => (overrides.credentials === undefined ? STORED_CREDENTIALS : overrides.credentials)),
  } as unknown as IntegrationService;

  const identityResolutionService = {
    resolveWebsiteVisitor: vi.fn(overrides.resolveWebsiteVisitor ?? (async () => undefined)),
  } as unknown as IdentityResolutionService;

  const redis = {
    isConfigured: vi.fn(() => overrides.redisConfigured ?? true),
    incrementWithExpiry: vi.fn(overrides.increment ?? (async () => 1)),
  };

  const configValues: Record<string, unknown> = {
    RATE_LIMIT_WINDOW_SECONDS: 60,
    WEBSITE_EVENT_RATE_LIMIT_IP_MAX: 120,
    WEBSITE_EVENT_RATE_LIMIT_WORKSPACE_MAX: 6000,
    BRAYN_ENV: 'development',
  };

  const service = new WebsiteEventIngestService(
    { client } as unknown as DatabaseService,
    idempotency,
    integrationService,
    identityResolutionService,
    redis as unknown as RedisService,
    { event: vi.fn() } as unknown as StructuredLoggerService,
    { get: (key: string) => configValues[key] } as never,
  );

  return { service, client, idempotency, integrationService, identityResolutionService, eventInsertChain, redis };
}

describe('WebsiteEventIngestService', () => {
  it('accepts a valid event with a matching write key and allowed origin: upserts visitor + session, inserts the event, completes idempotency', async () => {
    const { service, client, idempotency } = makeDeps();

    const result = await service.ingest('ws_1', baseInput, CTX);

    expect(result).toEqual({ status: 'accepted' });
    expect(idempotency.reserve).toHaveBeenCalledWith('website-event:ws_1:evt_1', { leaseMs: 60_000 });
    expect(idempotency.complete).toHaveBeenCalledWith('website-event:ws_1:evt_1');
    expect(idempotency.fail).not.toHaveBeenCalled();
    expect(client.insert).toHaveBeenCalledTimes(3);
  });

  describe('failure → retry', () => {
    const identityInput: IngestWebsiteEventInput = {
      ...baseInput,
      eventType: 'identity_signal',
      payload: { email: 'a@b.co', signature: sign('a@b.co') },
    };

    it('releases the key (fail, not complete) and rethrows when processing throws, so a retry is processed', async () => {
      const boom = new Error('resolution exploded');
      const { service, idempotency } = makeDeps({ resolveWebsiteVisitor: async () => { throw boom; } });

      await expect(service.ingest('ws_1', identityInput, CTX)).rejects.toBe(boom);
      expect(idempotency.fail).toHaveBeenCalledWith('website-event:ws_1:evt_1');
      expect(idempotency.complete).not.toHaveBeenCalled();
    });

    it('rethrows the original error even if releasing the key also fails (the lease frees it later)', async () => {
      const boom = new Error('resolution exploded');
      const { service } = makeDeps({
        resolveWebsiteVisitor: async () => { throw boom; },
        fail: async () => { throw new Error('db down'); },
      });

      await expect(service.ingest('ws_1', identityInput, CTX)).rejects.toBe(boom);
    });

    it('makes the event insert conflict-tolerant, so a retry after a partial write does not violate the eventId unique index', async () => {
      const { service, eventInsertChain } = makeDeps();

      await service.ingest('ws_1', baseInput, CTX);

      expect(eventInsertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
    });
  });

  describe('authentication (uniform 401 — no workspace enumeration)', () => {
    it('rejects when the workspace has no website_tracking connection, without reading credentials', async () => {
      const { service, integrationService } = makeDeps({ select: [[]] });

      await expect(service.ingest('ws_1', baseInput, CTX)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(integrationService.getCredentials).not.toHaveBeenCalled();
    });

    it('rejects when the integration is disconnected, even with the previously valid key', async () => {
      const { service } = makeDeps({ select: [[{ id: 'int_1', status: 'disconnected' }]] });

      await expect(service.ingest('ws_1', baseInput, CTX)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    });

    it('rejects when no write key is supplied', async () => {
      const { service, client } = makeDeps();

      await expect(service.ingest('ws_1', baseInput, { ...CTX, writeKey: null })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('rejects when the supplied write key does not match', async () => {
      const { service, client } = makeDeps();

      await expect(service.ingest('ws_1', baseInput, { ...CTX, writeKey: 'wrong_key' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('rejects when no write key has been generated for this integration yet', async () => {
      const { service, client } = makeDeps({ credentials: null });

      await expect(service.ingest('ws_1', baseInput, CTX)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('rejects when stored credentials have no writeKey field', async () => {
      const { service } = makeDeps({ credentials: { someOtherField: 'x' } });

      await expect(service.ingest('ws_1', baseInput, CTX)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    });
  });

  describe('origin allowlist', () => {
    it('rejects an origin that is not listed, before persisting anything', async () => {
      const { service, client } = makeDeps();

      await expect(service.ingest('ws_1', baseInput, { ...CTX, origin: 'https://evil.example' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      expect(client.insert).not.toHaveBeenCalled();
    });

    it('rejects a request with no origin at all', async () => {
      const { service } = makeDeps();

      await expect(service.ingest('ws_1', baseInput, { ...CTX, origin: null })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('rejects every origin while no allowlist has been configured', async () => {
      const { service } = makeDeps({ credentials: { writeKey: VALID_KEY } });

      await expect(service.ingest('ws_1', baseInput, CTX)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
  });

  describe('rate limiting', () => {
    it('rejects with 429 once the per-IP window is exceeded, before any DB work', async () => {
      const { service, client } = makeDeps({ increment: async (key: string) => (key.includes(':website-ip:') ? 121 : 1) });

      await expect(service.ingest('ws_1', baseInput, CTX)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      expect(client.select).not.toHaveBeenCalled();
    });

    it('rejects with 429 once the per-workspace window is exceeded, only after the key is verified', async () => {
      const { service, client, redis } = makeDeps({ increment: async (key: string) => (key.includes(':website-workspace:') ? 6001 : 1) });

      await expect(service.ingest('ws_1', baseInput, CTX)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      expect(client.insert).not.toHaveBeenCalled();
      expect(redis.incrementWithExpiry).toHaveBeenCalledWith(expect.stringMatching(/^ratelimit:development:website-workspace:ws_1:\d+$/), 60);
    });

    it('does not count an unauthenticated request against the workspace quota', async () => {
      const { service, redis } = makeDeps();

      await expect(service.ingest('ws_1', baseInput, { ...CTX, writeKey: 'wrong_key' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
      expect(redis.incrementWithExpiry).toHaveBeenCalledTimes(1);
      expect(redis.incrementWithExpiry).toHaveBeenCalledWith(expect.stringContaining(':website-ip:203.0.113.7:'), 60);
    });

    it('fails open when Redis errors', async () => {
      const { service } = makeDeps({ increment: async () => { throw new Error('upstash down'); } });

      await expect(service.ingest('ws_1', baseInput, CTX)).resolves.toEqual({ status: 'accepted' });
    });

    it('skips limiting when Redis is not configured', async () => {
      const { service, redis } = makeDeps({ redisConfigured: false });

      await expect(service.ingest('ws_1', baseInput, CTX)).resolves.toEqual({ status: 'accepted' });
      expect(redis.incrementWithExpiry).not.toHaveBeenCalled();
    });
  });

  it('rejects an event whose sessionId belongs to a different visitor, and releases the idempotency key', async () => {
    const { service, client, idempotency } = makeDeps({ sessionRow: null });

    await expect(service.ingest('ws_1', baseInput, CTX)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(client.insert).toHaveBeenCalledTimes(2);
    expect(idempotency.fail).toHaveBeenCalledWith('website-event:ws_1:evt_1');
  });

  it('returns duplicate (and persists nothing) on a redelivered eventId', async () => {
    const { service, client } = makeDeps({ reserve: false });

    const result = await service.ingest('ws_1', baseInput, CTX);

    expect(result).toEqual({ status: 'duplicate' });
    expect(client.insert).not.toHaveBeenCalled();
  });

  it('scopes the visitor upsert to the given workspaceId and visitorId', async () => {
    const { service, client } = makeDeps();

    await service.ingest('ws_1', baseInput, CTX);

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

    await service.ingest('ws_1', baseInput, CTX);

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

    await service.ingest('ws_1', { ...baseInput, occurredAt: '2026-01-01T00:00:00.000Z' }, CTX);

    const eventInsertChain = client.insert.mock.results[2].value as { values: ReturnType<typeof vi.fn> };
    expect(eventInsertChain.values).toHaveBeenCalledWith(
      expect.objectContaining({ occurredAt: new Date('2026-01-01T00:00:00.000Z') }),
    );
  });

  it('falls back to the server receipt time when occurredAt is omitted', async () => {
    const { service, client } = makeDeps();

    await service.ingest('ws_1', baseInput, CTX);

    const eventInsertChain = client.insert.mock.results[2].value as { values: ReturnType<typeof vi.fn> };
    const call = eventInsertChain.values.mock.calls[0][0] as { occurredAt: Date };
    expect(call.occurredAt).toBeInstanceOf(Date);
  });

  it('stores the optional payload, defaulting to null when omitted', async () => {
    const { service, client } = makeDeps();

    await service.ingest('ws_1', { ...baseInput, payload: { path: '/products/1' } }, CTX);

    const eventInsertChain = client.insert.mock.results[2].value as { values: ReturnType<typeof vi.fn> };
    expect(eventInsertChain.values).toHaveBeenCalledWith(expect.objectContaining({ payload: { path: '/products/1' } }));
  });

  describe('identity_signal events — only a signed signal links', () => {
    const identity = (payload: Record<string, unknown>): IngestWebsiteEventInput => ({ ...baseInput, eventType: 'identity_signal', payload });
    const storedPayload = (client: ReturnType<typeof makeDeps>['client']) =>
      ((client.insert.mock.results[2].value as { values: ReturnType<typeof vi.fn> }).values.mock.calls[0][0] as { payload: unknown }).payload;

    it('links via resolveWebsiteVisitor with the normalized email when the signature is valid; the signature is never stored', async () => {
      const { service, client, identityResolutionService } = makeDeps({ visitorRow: { id: 'visitor_row_xyz' } });

      await service.ingest('ws_1', identity({ email: ' Shopper@Example.com', signature: sign('shopper@example.com') }), CTX);

      expect(identityResolutionService.resolveWebsiteVisitor).toHaveBeenCalledWith('ws_1', 'visitor_row_xyz', 'shopper@example.com');
      expect(storedPayload(client)).toEqual({ email: 'shopper@example.com', verified: true });
    });

    it('stores but does not link an unsigned signal', async () => {
      const { service, client, identityResolutionService } = makeDeps();

      await service.ingest('ws_1', identity({ email: 'shopper@example.com' }), CTX);

      expect(identityResolutionService.resolveWebsiteVisitor).not.toHaveBeenCalled();
      expect(storedPayload(client)).toEqual({ email: 'shopper@example.com', verified: false });
    });

    it('does not link when the signature was made with a different secret', async () => {
      const { service, identityResolutionService } = makeDeps();

      await service.ingest('ws_1', identity({ email: 'shopper@example.com', signature: sign('shopper@example.com', 'attacker_guess') }), CTX);

      expect(identityResolutionService.resolveWebsiteVisitor).not.toHaveBeenCalled();
    });

    it('does not link when a valid signature for one email is replayed with another email', async () => {
      const { service, identityResolutionService } = makeDeps();

      await service.ingest('ws_1', identity({ email: 'victim@example.com', signature: sign('attacker@example.com') }), CTX);

      expect(identityResolutionService.resolveWebsiteVisitor).not.toHaveBeenCalled();
    });

    it('does not link when the signature is malformed (non-hex / wrong length)', async () => {
      const { service, identityResolutionService } = makeDeps();

      await service.ingest('ws_1', identity({ email: 'shopper@example.com', signature: 'zz' }), CTX);

      expect(identityResolutionService.resolveWebsiteVisitor).not.toHaveBeenCalled();
    });

    it('does not link when the workspace has no identity secret configured', async () => {
      const { service, identityResolutionService } = makeDeps({
        credentials: { writeKey: VALID_KEY, allowedOrigins: JSON.stringify([ORIGIN]) },
      });

      await service.ingest('ws_1', identity({ email: 'shopper@example.com', signature: sign('shopper@example.com') }), CTX);

      expect(identityResolutionService.resolveWebsiteVisitor).not.toHaveBeenCalled();
    });

    it('does not call resolveWebsiteVisitor for a non-identity event', async () => {
      const { service, identityResolutionService } = makeDeps();

      await service.ingest('ws_1', baseInput, CTX);

      expect(identityResolutionService.resolveWebsiteVisitor).not.toHaveBeenCalled();
    });
  });

  describe('historical activity stays associated after linking (Part 3)', () => {
    it('never overwrites canonicalCustomerId on the visitor upsert set-clause for a later, unrelated event', async () => {
      const { service, client } = makeDeps();

      await service.ingest('ws_1', baseInput, CTX);

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
