import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { integrations } from '../../database/schema/integrations';
import { websiteVisitors } from '../../database/schema/website-visitors';
import { websiteSessions } from '../../database/schema/website-sessions';
import { websiteEvents } from '../../database/schema/website-events';
import { ConflictError, NotFoundError } from '../../common/errors/app-error';
import { IdempotencyService } from '../../common/idempotency/idempotency.service';
import type { IngestWebsiteEventInput } from './dto/ingest-website-event.schema';

export type WebsiteEventIngestResult = { status: 'accepted' } | { status: 'duplicate' };

/**
 * Minimal event intake for the Website Behaviour domain (doc06/doc20
 * "Website Tracking"; doc22 "Website Behaviour"). Mirrors
 * WebhookIngestService's shape — workspace/integration resolution,
 * idempotency reservation, persist — but there is no signed provider
 * delivery to verify here: no capture mechanism (a Shopify Web Pixel, a
 * tracking SDK) exists yet, so per-request authenticity (e.g. a write
 * key that client would embed) is intentionally deferred to that part,
 * not guessed here.
 *
 * This part's tenant-isolation gate is the same "must have a connected
 * integration for this (workspace, provider)" check every other
 * provider's webhook path already requires (see
 * WebhookIngestService.findIntegration()) — an ingest for a workspace
 * that never connected `website_tracking` is rejected the same way. A
 * merchant connects it through the existing generic
 * `POST /workspaces/:workspaceId/integrations` endpoint
 * (`{ provider: 'website_tracking' }`) — no new connect flow needed,
 * `IntegrationService.connect()` is already provider-agnostic.
 *
 * Deliberately does not implement anonymous → known identity linking
 * (doc09/doc20), UCIR wiring (doc08), Customer Activity History, or
 * downstream Health/Opportunity signal integration (doc10) — each is a
 * separate, later part; this part only accepts and stores events.
 */
@Injectable()
export class WebsiteEventIngestService {
  constructor(
    private readonly database: DatabaseService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async ingest(workspaceId: string, input: IngestWebsiteEventInput): Promise<WebsiteEventIngestResult> {
    const integration = await this.findIntegration(workspaceId);
    if (!integration) {
      throw new NotFoundError('This workspace has no connection for the website_tracking provider.');
    }
    if (integration.status === 'disconnected') {
      throw new ConflictError('Cannot ingest a website event for a disconnected integration.');
    }

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

    await this.idempotency.complete(idempotencyKey);
    return { status: 'accepted' };
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
