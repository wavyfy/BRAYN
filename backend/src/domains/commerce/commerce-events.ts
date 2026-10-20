import type { IntegrationProvider } from '../integration/dto/connect-integration.schema';

/**
 * Commerce domain events (doc21 — Event Naming / "External Checkout &
 * Payment Lifecycle Events": `order.created`, `order.updated`,
 * `order.cancelled`, `refund.processed` are produced from commerce data,
 * owned by the commerce integration). Emitted by OrderService — the domain
 * that owns the state change (doc21 Event Producers) — from normalized
 * records only: never a provider webhook topic or payload.
 *
 * Envelope `entityId` is the BRAYN order (or refund) id; `idempotencyKey`
 * identifies the state transition so a consumer can dedupe a re-emission.
 * `provider`/`orderExternalId` are source metadata (doc09 Source Identity
 * Mapping), not something a consumer should branch on.
 */
export interface OrderEventPayload {
  orderId: string;
  orderExternalId: string;
  provider: IntegrationProvider;
  /** Null until Identity Resolution has linked the order's customer, and for a guest checkout — consumers needing a customer skip it. */
  canonicalCustomerId: string | null;
  /** Source time of the change: placement (created), last modification (updated), cancellation (cancelled). */
  sourceOccurredAt: string | null;
}

export type OrderCreatedPayload = OrderEventPayload;
export type OrderUpdatedPayload = OrderEventPayload;
export type OrderCancelledPayload = OrderEventPayload;

export interface RefundProcessedPayload extends OrderEventPayload {
  refundId: string;
  refundExternalId: string;
  totalRefunded: string | null;
}
