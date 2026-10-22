import { z } from 'zod';
import { websiteEventTypes } from '../../../database/schema/website-events';

/** Client-generated ids (UUIDs from the SDK) — a narrow charset keeps arbitrary strings out of keys/rows. */
const clientId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** Upper bound on a serialized `payload` — the SDK sends a handful of short fields per event. */
export const MAX_PAYLOAD_BYTES = 4096;
/** `occurredAt` may lag (delayed beacon) or lead (client clock skew) server time only by this much. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * `visitorId`/`sessionId`/`eventId` are all caller-supplied by the
 * tracking client (doc20 — BRAYN never generates these). `occurredAt` is
 * optional: a beacon can be delayed/batched, so the client's own event
 * time is preferred where given, falling back to server receipt time —
 * but only inside [now − MAX_EVENT_AGE_MS, now + MAX_CLOCK_SKEW_MS], so a
 * caller can't back- or future-date activity into UCIR/Health.
 *
 * An `identity_signal` event must carry a valid `payload.email`, and may
 * carry `payload.signature` — the merchant-server HMAC that makes it a
 * *reliable* signal (doc09/doc20). Whether the signature is valid is
 * checked by `WebsiteEventIngestService`, which holds the secret.
 */
export const ingestWebsiteEventSchema = z
  .object({
    visitorId: clientId,
    sessionId: clientId,
    eventId: clientId,
    eventType: z.enum(websiteEventTypes),
    occurredAt: z
      .string()
      .datetime()
      .refine(
        (value) => {
          const offset = new Date(value).getTime() - Date.now();
          return offset <= MAX_CLOCK_SKEW_MS && offset >= -MAX_EVENT_AGE_MS;
        },
        { message: 'occurredAt is outside the accepted window.' },
      )
      .optional(),
    payload: z
      .record(z.string(), z.unknown())
      .refine((payload) => Buffer.byteLength(JSON.stringify(payload)) <= MAX_PAYLOAD_BYTES, {
        message: `payload must serialize to at most ${MAX_PAYLOAD_BYTES} bytes.`,
      })
      .optional(),
  })
  .refine(
    (input) =>
      input.eventType !== 'identity_signal' ||
      (z.string().trim().email().max(254).safeParse(input.payload?.email).success &&
        (input.payload?.signature === undefined || typeof input.payload.signature === 'string')),
    {
      message: 'An identity_signal event requires a valid payload.email (and payload.signature, if present, must be a string).',
      path: ['payload', 'email'],
    },
  );

export type IngestWebsiteEventInput = z.infer<typeof ingestWebsiteEventSchema>;
