import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { IntegrationService } from '../integration/integration.service';

/**
 * Generates/rotates the `website_tracking` write key (Part 2 — the
 * per-request authenticity mechanism `WebsiteEventIngestService`
 * validates). Unlike Shopify/WooCommerce credentials, this key isn't
 * merchant-supplied — BRAYN generates it and the merchant copies it into
 * the tracking snippet embedded on their storefront (same shape as any
 * analytics "write key"/"measurement id": client-embeddable, rotatable,
 * but not a server-side secret). Stored through the same
 * `IntegrationService.setCredentials()` encrypted-credential mechanism
 * every other provider uses — `connectCredentials()` is not used here
 * since there is no external provider connection to verify against.
 *
 * Returns the key in plaintext exactly once, on generation/rotation —
 * `IntegrationService.getCredentials()` is the only other way to read
 * it, and that's internal-only (never exposed through a controller),
 * matching this codebase's existing "credentials never returned by
 * list" discipline.
 */
@Injectable()
export class WebsiteTrackingKeyService {
  constructor(private readonly integrationService: IntegrationService) {}

  async generate(workspaceId: string): Promise<{ writeKey: string }> {
    const writeKey = randomBytes(24).toString('base64url');
    await this.integrationService.setCredentials(workspaceId, 'website_tracking', { writeKey });
    return { writeKey };
  }
}
