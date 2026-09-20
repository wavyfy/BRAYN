import { z } from 'zod';
import { websiteEventTypes } from '../../../database/schema/website-events';

/**
 * `visitorId`/`sessionId`/`eventId` are all caller-supplied by the
 * tracking client (doc20 — BRAYN never generates these). `occurredAt` is
 * optional: a beacon can be delayed/batched, so the client's own event
 * time is preferred where given, falling back to server receipt time.
 */
export const ingestWebsiteEventSchema = z.object({
  visitorId: z.string().min(1).max(255),
  sessionId: z.string().min(1).max(255),
  eventId: z.string().min(1).max(255),
  eventType: z.enum(websiteEventTypes),
  occurredAt: z.string().datetime().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export type IngestWebsiteEventInput = z.infer<typeof ingestWebsiteEventSchema>;
