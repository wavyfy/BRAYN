import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { websiteEvents } from '../../database/schema/website-events';
import { IntegrationService } from '../integration/integration.service';

/**
 * Manages the `website_tracking` integration's three settings, all kept
 * in the one encrypted credential payload every provider uses
 * (`IntegrationService.setCredentials()`/`getCredentials()`):
 *
 * - `writeKey` — client-embeddable, rotatable; the per-request
 *   authenticity check `WebsiteEventIngestService` validates. Public by
 *   nature (it sits in storefront HTML), so it is never the only control.
 * - `identitySecret` — server-side only, never embedded in a storefront.
 *   The merchant's server signs a logged-in shopper's email with it
 *   (HMAC-SHA256, see `WebsiteEventIngestService`), which is what makes an
 *   `identity_signal` a *reliable* signal (doc09/doc20) rather than an
 *   email anyone holding the write key could claim.
 * - `allowedOrigins` — storefront origins the write key is accepted from
 *   (JSON array; stored here only to avoid a second storage path).
 *
 * Every update merges into the existing payload, so rotating one setting
 * never wipes another. Secrets are returned in plaintext exactly once, on
 * generation/rotation; nothing here exposes them otherwise.
 */
export interface WebsiteTrackingSettings {
  allowedOrigins: string[];
  writeKeyConfigured: boolean;
  identitySecretConfigured: boolean;
  /** Most recent event's `occurredAt` — the merchant's "is my snippet working?" signal. */
  lastEventAt: Date | null;
}

@Injectable()
export class WebsiteTrackingKeyService {
  constructor(
    private readonly integrationService: IntegrationService,
    private readonly database: DatabaseService,
  ) {}

  /** Current state for the setup UI. Never returns the write key or identity secret themselves. */
  async getSettings(workspaceId: string): Promise<WebsiteTrackingSettings> {
    const credentials = (await this.integrationService.getCredentials(workspaceId, 'website_tracking')) ?? {};
    const [last] = await this.database.client
      .select({ lastEventAt: sql<string | null>`max(${websiteEvents.occurredAt})` })
      .from(websiteEvents)
      .where(eq(websiteEvents.workspaceId, workspaceId));

    return {
      allowedOrigins: credentials.allowedOrigins ? (JSON.parse(credentials.allowedOrigins) as string[]) : [],
      writeKeyConfigured: Boolean(credentials.writeKey),
      identitySecretConfigured: Boolean(credentials.identitySecret),
      // A raw aggregate comes back from pg as a string, not a Date (same caveat as CustomerIntelligenceService).
      lastEventAt: last?.lastEventAt ? new Date(last.lastEventAt) : null,
    };
  }

  async generate(workspaceId: string): Promise<{ writeKey: string }> {
    const writeKey = randomBytes(24).toString('base64url');
    await this.update(workspaceId, { writeKey });
    return { writeKey };
  }

  async generateIdentitySecret(workspaceId: string): Promise<{ identitySecret: string }> {
    const identitySecret = randomBytes(32).toString('base64url');
    await this.update(workspaceId, { identitySecret });
    return { identitySecret };
  }

  /** `origins` are already normalized by the DTO (`URL.origin`, deduped). */
  async setAllowedOrigins(workspaceId: string, origins: string[]): Promise<{ allowedOrigins: string[] }> {
    await this.update(workspaceId, { allowedOrigins: JSON.stringify(origins) });
    return { allowedOrigins: origins };
  }

  private async update(workspaceId: string, changes: Record<string, string>): Promise<void> {
    const existing = (await this.integrationService.getCredentials(workspaceId, 'website_tracking')) ?? {};
    await this.integrationService.setCredentials(workspaceId, 'website_tracking', { ...existing, ...changes });
  }
}
