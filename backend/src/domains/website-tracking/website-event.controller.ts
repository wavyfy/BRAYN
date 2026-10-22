import { Body, Controller, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/public.decorator';
import { SkipRateLimit } from '../../common/rate-limit/rate-limit.decorator';
import { ZodValidationPipe } from '../../common/api/zod-validation.pipe';
import { ValidationError } from '../../common/errors/app-error';
import { WebsiteEventIngestService } from './website-event-ingest.service';
import { ingestWebsiteEventSchema, type IngestWebsiteEventInput } from './dto/ingest-website-event.schema';

/**
 * Website Behaviour event intake (doc06/doc20 "Website Tracking").
 * `@Public()` — the tracking client runs in a storefront visitor's
 * browser, cross-origin from BRAYN's own API, with no Clerk session;
 * per-request authenticity is the write key plus the storefront origin
 * allowlist (see `WebsiteEventIngestService`), not Clerk. `@SkipRateLimit()`
 * because the global guard's shared per-IP public tier (20/window) would
 * throttle real shoppers — this route enforces its own per-IP and
 * per-workspace limits inside `WebsiteEventIngestService` instead.
 *
 * Deliberately CORS-header-free: the tracking SDK
 * (`frontend/public/tracking.js`) only ever sends CORS-"simple"
 * requests — no custom headers, a `text/plain` body, the write key in
 * the query string rather than a header — so a browser never issues a
 * CORS preflight for this route, and the app's global `enableCors()`
 * origin allowlist (locked to `FRONTEND_URL` for the authenticated API)
 * never needs loosening for arbitrary merchant storefront origins. A
 * CORS-simple cross-origin POST is always sent regardless of response
 * headers; the SDK never reads the response (`sendBeacon` can't, and
 * its `fetch` fallback doesn't try), so an unreadable/opaque response
 * is fine and no `Access-Control-Allow-Origin` header is needed here.
 *
 * The body may arrive as `application/json` (direct API callers —
 * tests, server-to-server) or as text (the SDK's `text/plain` Blob,
 * chosen specifically to keep `sendBeacon`/`fetch` CORS-simple) — both
 * are normalized before validation.
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
    @Query('key') writeKey: string | undefined,
    @Req() request: FastifyRequest,
    @Body() rawBody: unknown,
  ) {
    const parsed = typeof rawBody === 'string' ? this.parseJson(rawBody) : rawBody;
    const body = new ZodValidationPipe(ingestWebsiteEventSchema).transform(parsed) as IngestWebsiteEventInput;

    return this.websiteEventIngestService.ingest(workspaceId, body, {
      writeKey: writeKey ?? null,
      origin: requestOrigin(request),
      ip: request.ip,
    });
  }

  private parseJson(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ValidationError('Request body is not valid JSON.');
    }
  }
}

/** Browsers send `Origin` on every cross-origin POST (beacon included); `Referer` is the fallback. Null when neither parses. */
function requestOrigin(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin !== 'null') return origin;

  const referer = request.headers.referer;
  if (typeof referer !== 'string') return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}
