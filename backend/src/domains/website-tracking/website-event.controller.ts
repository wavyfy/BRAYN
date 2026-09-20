import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Public } from '../../common/auth/public.decorator';
import { SkipRateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { WebsiteEventIngestService } from './website-event-ingest.service';
import { ingestWebsiteEventSchema, type IngestWebsiteEventInput } from './dto/ingest-website-event.schema';

/**
 * Website Behaviour event intake (doc06/doc20 "Website Tracking").
 * `@Public()` like WebhookController — the tracking client runs in an
 * anonymous visitor's browser, with no Clerk session; tenant isolation
 * comes from requiring a connected `website_tracking` integration for
 * `:workspaceId` (see WebsiteEventIngestService's doc comment).
 * `@SkipRateLimit()` for the same reason as WebhookController:
 * legitimate storefront traffic can burst, and there is no Clerk
 * identity here to key a limit on.
 */
@Controller('workspaces/:workspaceId/website-events')
export class WebsiteEventController {
  constructor(private readonly websiteEventIngestService: WebsiteEventIngestService) {}

  @Public()
  @SkipRateLimit()
  @Post()
  @HttpCode(HttpStatus.OK)
  async ingest(
    @Param('workspaceId') workspaceId: string,
    @Body(new ZodValidationPipe(ingestWebsiteEventSchema)) body: IngestWebsiteEventInput,
  ) {
    return this.websiteEventIngestService.ingest(workspaceId, body);
  }
}
