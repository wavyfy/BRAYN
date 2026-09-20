import { Module } from '@nestjs/common';
import { WebsiteEventController } from './website-event.controller';
import { WebsiteEventIngestService } from './website-event-ingest.service';

/**
 * Website Behaviour domain (doc06 Integration Sources — "Website
 * Tracking"; doc22 — "Website Behaviour"). Part 1: schema + minimal
 * event intake only — see WebsiteEventIngestService's doc comment for
 * what is deliberately not built yet.
 */
@Module({
  controllers: [WebsiteEventController],
  providers: [WebsiteEventIngestService],
})
export class WebsiteTrackingModule {}
