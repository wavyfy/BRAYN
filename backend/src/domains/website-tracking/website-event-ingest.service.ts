import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { websiteVisitors } from '../../database/schema/website-visitors';
import { websiteSessions } from '../../database/schema/website-sessions';
import { websiteEvents } from '../../database/schema/website-events';
import { ConflictError, RateLimitError, UnauthenticatedError, UnauthorizedError } from '../../common/errors/app-error';
import { IdempotencyService, INGEST_IDEMPOTENCY_LEASE_MS } from '../../common/idempotency/idempotency.service';
import { RedisService } from '../../common/rate-limit/redis.service';
import { StructuredLoggerService } from '../../common/logging/structured-logger.service';
import type { Env } from '../../config/env.schema';
import { IntegrationService } from '../integration/integration.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import type { IngestWebsiteEventInput } from './dto/ingest-website-event.schema';

export type WebsiteEventIngestResult = { status: 'accepted' } | { status: 'duplicate' };

export interface WebsiteEventRequestContext {
  writeKey: string | null;
  /** The request's browser origin (`Origin`, else `Referer`'s origin); null when absent. */
  origin: string | null;
  ip: string;
}

/** The exact string a merchant server signs for an `identity_signal`: HMAC-SHA256(identitySecret, this), hex. */
export function identitySignaturePayload(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Event intake for the Website Behaviour domain (doc06/doc20 "Website
 * Tracking"; doc22 "Website Behaviour"). Mirrors WebhookIngestService's
 * shape — workspace/integration resolution, authenticity check,
 * idempotency reservation, persist.
 *
 * The write key is public by design (it sits in storefront HTML), so it
 * is one layer among several, checked in this order:
 * 1. Per-IP rate limit (before any DB work, across all workspaces).
 * 2. A `connected` `website_tracking` integration and a matching write
 *    key (timing-safe). A missing integration, a disconnected one and a
 *    wrong key all fail with the same 401, so an unauthenticated caller
 *    can't probe which workspaces have tracking set up. Fail-closed,
 *    including when no key has been generated yet — a security boundary
 *    (doc18), unlike RateLimitGuard's fail-open.
 * 3. Origin allowlist (`allowedOrigins`): the request's browser origin
 *    must be one the merchant listed; a missing origin or an empty list
 *    rejects. Stops the key being reused from other sites in a browser —
 *    a non-browser caller can forge the header, which is why (1)/(4)
 *    exist and why identity linking needs (5).
 * 4. Per-workspace rate limit (after auth, so an unauthenticated caller
 *    can't exhaust a merchant's quota).
 * 5. `identity_signal` linking only when `payload.signature` is a valid
 *    HMAC of the email under the workspace's server-side `identitySecret`
 *    (doc09/doc20 — "Anonymous activity must not be linked to a customer
 *    using weak or ambiguous identity signals"; an email any key holder
 *    can type is exactly that). An unsigned/invalid signal is still stored
 *    — as `{ email, verified: false }`, signature never persisted — but
 *    links nothing.
 *
 * Rate limits are Redis fixed windows (same primitive and fail-open
 * stance as RateLimitGuard: an availability control, not the security
 * boundary). ponytail: fixed window allows ~2x burst at a window edge;
 * switch to a sliding window if that proves exploitable.
 *
 * Still deliberately does not wire website events into Health
 * recalculation, Opportunities or Recommendations — separate later items.
 */
@Injectable()
export class WebsiteEventIngestService {
  private readonly windowSeconds: number;
  private readonly ipMax: number;
  private readonly workspaceMax: number;
  private readonly environment: Env['BRAYN_ENV'];

  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
    private readonly integrationService: IntegrationService,
    private readonly identityResolutionService: IdentityResolutionService,
    private readonly redis: RedisService,
    private readonly logger: StructuredLoggerService,
    config: ConfigService<Env, true>,
  ) {
    this.windowSeconds = config.get('RATE_LIMIT_WINDOW_SECONDS', { infer: true });
    this.ipMax = config.get('WEBSITE_EVENT_RATE_LIMIT_IP_MAX', { infer: true });
    this.workspaceMax = config.get('WEBSITE_EVENT_RATE_LIMIT_WORKSPACE_MAX', { infer: true });
    this.environment = config.get('BRAYN_ENV', { infer: true });
  }

  async ingest(workspaceId: string, input: IngestWebsiteEventInput, context: WebsiteEventRequestContext): Promise<WebsiteEventIngestResult> {
    await this.enforceRateLimit('website-ip', context.ip, this.ipMax);

    const credentials = await this.authenticate(workspaceId, context.writeKey);
    this.verifyOrigin(credentials.allowedOrigins, context.origin);

    await this.enforceRateLimit('website-workspace', workspaceId, this.workspaceMax);

    const idempotencyKey = `website-event:${workspaceId}:${input.eventId}`;
    const reserved = await this.idempotency.reserve(idempotencyKey, { leaseMs: INGEST_IDEMPOTENCY_LEASE_MS });
    if (!reserved) {
      // Completed, or another attempt holds it — either way the SDK never
      // retries, so there's nothing to signal back beyond "not accepted twice".
      return { status: 'duplicate' };
    }

    try {
      await this.persist(workspaceId, input, credentials.identitySecret);
    } catch (error) {
      // Release so a retry with the same eventId is processed again rather
      // than reported 'duplicate'; if this write also fails, the lease
      // still frees the key.
      await this.idempotency.fail(idempotencyKey).catch(() => undefined);
      throw error;
    }

    await this.idempotency.complete(idempotencyKey);
    return { status: 'accepted' };
  }

  /** Every write here is retry-safe: upserts, plus a conflict-tolerant event insert (a failed attempt may already have written the row). */
  private async persist(workspaceId: string, input: IngestWebsiteEventInput, identitySecret: string | undefined): Promise<void> {
    const now = new Date();

    const [visitor] = await this.database.client
      .insert(websiteVisitors)
      .values({ workspaceId, visitorId: input.visitorId, lastSeenAt: now })
      .onConflictDoUpdate({
        target: [websiteVisitors.workspaceId, websiteVisitors.visitorId],
        set: { lastSeenAt: now },
      })
      .returning();

    // A session key belongs to the visitor that first used it — an event
    // claiming someone else's session matches no row here and is rejected
    // rather than attached to that session.
    const [session] = await this.database.client
      .insert(websiteSessions)
      .values({ workspaceId, visitorId: visitor.id, sessionKey: input.sessionId, lastEventAt: now })
      .onConflictDoUpdate({
        target: [websiteSessions.workspaceId, websiteSessions.sessionKey],
        set: { lastEventAt: now },
        setWhere: eq(websiteSessions.visitorId, visitor.id),
      })
      .returning();
    if (!session) {
      throw new ConflictError('This session belongs to a different visitor.');
    }

    const identity = input.eventType === 'identity_signal' ? this.verifyIdentitySignal(input.payload ?? {}, identitySecret) : null;

    await this.database.client
      .insert(websiteEvents)
      .values({
        workspaceId,
        visitorId: visitor.id,
        sessionId: session.id,
        eventId: input.eventId,
        eventType: input.eventType,
        payload: identity ? { email: identity.email, verified: identity.verified } : (input.payload ?? null),
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : now,
      })
      .onConflictDoNothing({ target: [websiteEvents.workspaceId, websiteEvents.eventId] });

    if (identity?.verified) {
      await this.identityResolutionService.resolveWebsiteVisitor(workspaceId, visitor.id, identity.email);
    }
  }

  /** DTO validation already guarantees `payload.email` is a valid email and `signature`, if present, a string. */
  private verifyIdentitySignal(payload: Record<string, unknown>, identitySecret: string | undefined): { email: string; verified: boolean } {
    const email = identitySignaturePayload(payload.email as string);
    const signature = payload.signature;
    if (!identitySecret || typeof signature !== 'string') {
      return { email, verified: false };
    }

    const expected = createHmac('sha256', identitySecret).update(email).digest();
    const supplied = Buffer.from(signature, 'hex');
    return { email, verified: supplied.length === expected.length && timingSafeEqual(supplied, expected) };
  }

  private async authenticate(workspaceId: string, writeKey: string | null): Promise<{ allowedOrigins?: string; identitySecret?: string }> {
    const integration = await this.findIntegration(workspaceId);
    const credentials = integration && integration.status !== 'disconnected'
      ? await this.integrationService.getCredentials(workspaceId, 'website_tracking')
      : null;
    const expected = credentials?.writeKey;

    if (!expected || !writeKey) {
      throw new UnauthenticatedError('Missing or invalid write key.');
    }

    const expectedBuffer = Buffer.from(expected);
    const suppliedBuffer = Buffer.from(writeKey);
    // timingSafeEqual throws on a length mismatch rather than returning false.
    if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
      throw new UnauthenticatedError('Missing or invalid write key.');
    }

    return credentials;
  }

  private verifyOrigin(allowedOriginsJson: string | undefined, origin: string | null): void {
    const allowed = allowedOriginsJson ? (JSON.parse(allowedOriginsJson) as string[]) : [];
    if (!origin || !allowed.includes(origin)) {
      throw new UnauthorizedError('This origin is not allowed for this write key.');
    }
  }

  private async enforceRateLimit(scope: string, identity: string, max: number): Promise<void> {
    if (!this.redis.isConfigured() || !this.environment) {
      return;
    }

    const bucket = Math.floor(Date.now() / 1000 / this.windowSeconds);
    let count: number;
    try {
      count = await this.redis.incrementWithExpiry(`ratelimit:${this.environment}:${scope}:${identity}:${bucket}`, this.windowSeconds);
    } catch (error) {
      this.logger.event('error', 'Website event rate limit check failed — failing open', 'WebsiteEventIngestService', {
        errorType: error instanceof Error ? error.constructor.name : typeof error,
        scope,
      });
      return;
    }

    if (count > max) {
      this.logger.event('warn', 'Website event rate limit exceeded', 'WebsiteEventIngestService', { scope, identity, count, max });
      throw new RateLimitError();
    }
  }

  private async findIntegration(workspaceId: string) {
    const [integration] = await this.database.client
      .select({ id: integrations.id, status: integrations.status })
      .from(integrations)
      .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'website_tracking')))
      .limit(1);

    return integration ?? null;
  }
}
