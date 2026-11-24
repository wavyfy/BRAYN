import { Injectable, type OnModuleInit } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ValidationError } from '../../../../common/errors/app-error';
import { normalizePhoneE164 } from '../../../../common/identity/phone';
import type {
  NormalizedCheckoutSignal,
  ParsedWebhookEvent,
  ProviderAdapter,
} from '../../provider-adapter.interface';
import { ProviderRegistry } from '../../provider-registry.service';

/** The only payload version this adapter parses — the one whose envelope carries event_type, event_id, event_time, store and session_id (docs.flexype.io/webhooks/2026-05/acr). */
export const FLEXYPE_WEBHOOK_VERSION = '2026-05';
/** Event types BRAYN acts on. Everything else FlexyPe sends (ABANDONED_SESSION, PRODUCT_VIEWED, COLLECTION_VIEWED, CUSTOMER_CREATED/NEW_CUSTOMER) is acknowledged and ignored. */
export const FLEXYPE_PROCESSED_EVENT_TYPES = ['ABANDONED_CHECKOUT'] as const;

const MAX_CART_ITEMS = 100;

/**
 * FlexyPe — external checkout signal source (doc06 "External Checkout & Payment Signal Sources", doc20 FlexyPe).
 * Webhook intake only: FlexyPe has no API for listing past checkouts, so there is nothing to import, and BRAYN
 * never creates commerce orders or customers from it (Shopify stays the commerce source of truth).
 *
 * Provider contract (docs.flexype.io, webhook version 2026-05, read Nov 24, 2026):
 * - auth: `X-Flexype-Authorization` carries the merchant-configured secret verbatim (no HMAC);
 * - `X-Event-Id` identifies the event and is reused on retries → the dedup key;
 * - `X-Webhook-Version` names the payload version; only 2026-05 is parsed (2025-09 has no event type, event id,
 *   timestamp or session id in its body, so it can't be deduplicated or correlated reliably) — anything else is a 400,
 *   never silently accepted;
 * - FlexyPe expects HTTP 200 within 10 s; the generic pipeline only persists the row before answering.
 *
 * Data minimization (doc18): the stored payload keeps only what checkout intelligence and later identity linking need.
 * Client IP, user agent, ad identifiers, UTM data, coupons, checkout URL, names and addresses are dropped here, at the
 * integration boundary, and never reach the database.
 */
@Injectable()
export class FlexyPeAdapter implements ProviderAdapter, OnModuleInit {
  readonly provider = 'flexype' as const;

  constructor(private readonly registry: ProviderRegistry) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** No provider API call backs a FlexyPe connection — the merchant configures the webhook secret BRAYN generates. */
  async verifyConnection(): Promise<boolean> {
    return true;
  }

  verifyWebhookSignature(
    _rawBody: string,
    headers: Record<string, string>,
    secret: string,
  ): boolean {
    const presented = headers['x-flexype-authorization'];
    if (typeof presented !== 'string' || presented.length === 0) {
      return false;
    }
    // Equal-length digests: no length leak, and timingSafeEqual never throws.
    return timingSafeEqual(sha256(presented), sha256(secret));
  }

  parseWebhookEvent(rawBody: string, headers: Record<string, string>): ParsedWebhookEvent | null {
    const version = headers['x-webhook-version'];
    if (version !== FLEXYPE_WEBHOOK_VERSION) {
      throw new ValidationError(
        `Unsupported FlexyPe webhook version; configure version ${FLEXYPE_WEBHOOK_VERSION}.`,
      );
    }
    const eventId = headers['x-event-id'];
    if (typeof eventId !== 'string' || eventId.trim() === '') {
      throw new ValidationError('Missing X-Event-Id header.');
    }

    const body = parseJsonObject(rawBody);
    const eventType = body.event_type;
    if (
      typeof eventType !== 'string' ||
      !(FLEXYPE_PROCESSED_EVENT_TYPES as readonly string[]).includes(eventType)
    ) {
      return null;
    }

    const signal = normalizeAbandonedCheckout(body);
    return {
      externalEventId: eventId.trim(),
      eventType,
      payload: { resource: 'checkout', data: signal },
      // FlexyPe documents Shopify stores only (store.shopify_domain).
      store: { provider: 'shopify', domain: signal.shopDomain },
    };
  }
}

/** 2026-05 ABANDONED_CHECKOUT → the minimized, provider-neutral checkout signal. Throws ValidationError on a missing required field. */
export function normalizeAbandonedCheckout(
  body: Record<string, unknown>,
): NormalizedCheckoutSignal {
  const store = asObject(body.store);
  const payload = asObject(body.payload);
  const user = asObject(payload.user);
  const context = asObject(payload.checkout_context);

  const shopDomain = text(store.shopify_domain)?.toLowerCase();
  const sessionId = text(payload.session_id);
  const stage = text(payload.session_state);
  const occurredAt = text(body.event_time);
  if (!shopDomain || !sessionId || !stage || !occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    throw new ValidationError(
      'ABANDONED_CHECKOUT payload is missing store.shopify_domain, payload.session_id, payload.session_state or a valid event_time.',
    );
  }

  const email = text(user.email)?.toLowerCase() ?? null;
  const phone =
    normalizePhoneE164(text(user.phone_with_dial_code)) ??
    normalizePhoneE164(
      text(user.dial_code) && text(user.phone)
        ? `${text(user.dial_code)}${text(user.phone)}`
        : null,
    );
  const customerType =
    user.customer_type === 'NEW' || user.customer_type === 'REPEAT' ? user.customer_type : null;
  const items = (Array.isArray(payload.cart_items) ? payload.cart_items : [])
    .slice(0, MAX_CART_ITEMS)
    .map((raw) => {
      const item = asObject(raw);
      const quantity = Number(item.quantity);
      return {
        productExternalId: idText(item.product_id),
        variantExternalId: idText(item.variant_id),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 0,
        totalPrice: idText(item.total_price),
      };
    });

  return {
    kind: 'abandoned',
    sessionId,
    stage,
    occurredAt: new Date(occurredAt).toISOString(),
    shopDomain,
    currency: text(context.presentment_currency) ?? text(context.store_currency) ?? null,
    email,
    phone,
    customerType,
    items,
  };
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function parseJsonObject(rawBody: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new ValidationError('Webhook body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('Webhook body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Provider ids and amounts can arrive as numbers or strings; kept as strings so nothing loses precision. */
function idText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return text(value) ?? null;
}
