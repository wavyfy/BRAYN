import { z } from 'zod';
import { websiteEventTypes } from '../../../database/schema/website-events';

/**
 * `visitorId`/`sessionId`/`eventId` are all caller-supplied by the
 * tracking client (doc20 — BRAYN never generates these). `occurredAt` is
 * optional: a beacon can be delayed/batched, so the client's own event
 * time is preferred where given, falling back to server receipt time.
 *
 * An `identity_signal` event (Part 3) must carry a `payload.email` — the
 * one deterministic identity signal doc09 names; an insufficient signal
 * (missing/blank email) is rejected here, before it ever reaches
 * Identity Resolution, rather than silently accepted and ignored.
 */
export const ingestWebsiteEventSchema = z
  .object({
    visitorId: z.string().min(1).max(255),
    sessionId: z.string().min(1).max(255),
    eventId: z.string().min(1).max(255),
    eventType: z.enum(websiteEventTypes),
    occurredAt: z.string().datetime().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((input) => input.eventType !== 'identity_signal' || typeof input.payload?.email === 'string' && input.payload.email.trim().length > 0, {
    message: 'An identity_signal event requires a non-empty payload.email.',
    path: ['payload', 'email'],
  });

export type IngestWebsiteEventInput = z.infer<typeof ingestWebsiteEventSchema>;
