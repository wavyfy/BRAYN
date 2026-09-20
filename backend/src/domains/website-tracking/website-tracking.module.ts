import { Module } from '@nestjs/common';
import { WorkspaceModule } from '../workspace/workspace.module';
import { IntegrationModule } from '../integration/integration.module';
import { WebsiteEventController } from './website-event.controller';
import { WebsiteEventIngestService } from './website-event-ingest.service';
import { WebsiteTrackingKeyController } from './website-tracking-key.controller';
import { WebsiteTrackingKeyService } from './website-tracking-key.service';

/**
 * Website Behaviour domain (doc06 Integration Sources — "Website
 * Tracking"; doc22 — "Website Behaviour"). Part 1: schema + event
 * intake. Part 2: the storefront capture mechanism (`frontend/public/
 * tracking.js`) and its write-key authenticity check — see
 * `WebsiteEventIngestService`/`WebsiteTrackingKeyService`'s doc comments
 * for what is deliberately still not built.
 *
 * Imports WorkspaceModule for WorkspaceMembershipGuard (the write-key
 * endpoint is authenticated, unlike the public event-intake endpoint)
 * and IntegrationModule for IntegrationService's credential storage —
 * same reuse pattern as DashboardModule/IntegrationController.
 */
@Module({
  imports: [WorkspaceModule, IntegrationModule],
  controllers: [WebsiteEventController, WebsiteTrackingKeyController],
  providers: [WebsiteEventIngestService, WebsiteTrackingKeyService],
})
export class WebsiteTrackingModule {}
