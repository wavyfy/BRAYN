import { Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { websiteVisitors } from '../../database/schema/website-visitors';
import { websiteSessions } from '../../database/schema/website-sessions';
import { websiteEvents } from '../../database/schema/website-events';
import { ConflictError, NotFoundError, UnauthenticatedError } from '../../common/errors/app-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import { IntegrationService } from '../integration/integration.service';
import { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import type { IngestWebsiteEventInput } from './dto/ingest-website-event.schema';

export type WebsiteEventIngestResult = { status: 'accepted' } | { status: 'duplicate' };

/**
 * Minimal event intake for the Website Behaviour domain (doc06/doc20
 * "Website Tracking"; doc22 "Website Behaviour"). Mirrors
 * WebhookIngestService's shape — workspace/integration resolution,
 * authenticity check, idempotency reservation, persist.
 *
 * Tenant isolation is two layers, same spirit as a provider webhook:
 * (1) a `connected` `website_tracking` integration must exist for this
 * workspace (see `findIntegration()` — same shape as
 * `WebhookIngestService.findIntegration()`; a merchant connects it via
 * the existing generic `POST /workspaces/:workspaceId/integrations`,
 * `{ provider: 'website_tracking' }`), and (2) the request's write key
 * (Part 2 — `WebsiteTrackingKeyService`) must match the one stored for
 * that integration via `IntegrationService.setCredentials()`/
 * `getCredentials()` — the same encrypted-credential mechanism every
 * other provider uses, reused here for a client-embeddable key rather
 * than a server-side API secret. Fail-closed: a missing or unmatched
 * key is always rejected, including when no key has been generated
 * yet — unlike RateLimitGuard's fail-open, this is a security boundary
 * (doc18), not an availability one.
 *
 * Anonymous → known identity linking (Part 3): an `identity_signal`
 * event's `payload.email` (validated non-empty by the DTO) is handed to
 * `IdentityResolutionService.resolveWebsiteVisitor()` right after the
 * event itself is persisted — a separate call, not folded into Identity
 * Resolution's own transaction, same "record the signal, then act on
 * it" shape `resolveMany` already uses when Integration calls it after
 * `CustomerService.upsertMany`. Every other event type is stored as
 * before with no identity side effect.
 *
 * Still deliberately does not implement UCIR wiring (doc08), Customer
 * Activity History, or downstream Health/Opportunity signal integration
 * (doc10) — each is a separate, later part; this part only accepts and
 * stores events (plus, now, resolves the one identity signal doc09
 * names).
 */
@Injectable()
export class WebsiteEventIngestService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
    private readonly integrationService: IntegrationService,
    private readonly identityResolutionService: IdentityResolutionService,
  ) {}

  async ingest(workspaceId: string, input: IngestWebsiteEventInput, writeKey: string | null): Promise<WebsiteEventIngestResult> {
    const integration = await this.findIntegration(workspaceId);
    if (!integration) {
      throw new NotFoundError('This workspace has no connection for the website_tracking provider.');
    }
    if (integration.status === 'disconnected') {
      throw new ConflictError('Cannot ingest a website event for a disconnected integration.');
    }

    await this.verifyWriteKey(workspaceId, writeKey);

    const idempotencyKey = `website-event:${workspaceId}:${input.eventId}`;
    const reserved = await this.idempotency.reserve(idempotencyKey);
    if (!reserved) {
      return { status: 'duplicate' };
    }

    // No persisted "failed" marker exists for this table (unlike
    // integration_webhook_events' status column) — on a thrown error
    // below, the idempotency key stays reserved, matching
    // WebhookIngestService's own failure behavior: a retry with the same
    // eventId comes back 'duplicate', not silently retried (see
    // IdempotencyService.reserve()'s doc comment).
    const now = new Date();

    const [visitor] = await this.database.client
      .insert(websiteVisitors)
      .values({ workspaceId, visitorId: input.visitorId, lastSeenAt: now })
      .onConflictDoUpdate({
        target: [websiteVisitors.workspaceId, websiteVisitors.visitorId],
        set: { lastSeenAt: now },
      })
      .returning();

    const [session] = await this.database.client
      .insert(websiteSessions)
      .values({ workspaceId, visitorId: visitor.id, sessionKey: input.sessionId, lastEventAt: now })
      .onConflictDoUpdate({
        target: [websiteSessions.workspaceId, websiteSessions.sessionKey],
        set: { lastEventAt: now },
      })
      .returning();

    await this.database.client.insert(websiteEvents).values({
      workspaceId,
      visitorId: visitor.id,
      sessionId: session.id,
      eventId: input.eventId,
      eventType: input.eventType,
      payload: input.payload ?? null,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : now,
    });

    if (input.eventType === 'identity_signal') {
      // DTO validation already guarantees a non-empty string here.
      const email = input.payload?.email as string;
      await this.identityResolutionService.resolveWebsiteVisitor(workspaceId, visitor.id, email);
    }

    await this.idempotency.complete(idempotencyKey);
    return { status: 'accepted' };
  }

  private async verifyWriteKey(workspaceId: string, writeKey: string | null): Promise<void> {
    const credentials = await this.integrationService.getCredentials(workspaceId, 'website_tracking');
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
