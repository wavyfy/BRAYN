import { randomUUID } from 'node:crypto';
import { RequestContext } from '../logging/request-context';

/**
 * Canonical event envelope, matching "21. BRAYN Event & Webhook
 * Contracts" (Event Contract) exactly. No concrete event types are
 * defined here — the owning domain defines its own event names
 * ("customer.created" etc.) once that domain exists; this is only the
 * shared shape every one of them uses.
 */
export interface DomainEvent<TPayload = unknown> {
  id: string;
  type: string;
  version: number;
  workspaceId?: string;
  entityId?: string;
  occurredAt: string;
  correlationId?: string;
  idempotencyKey?: string;
  payload: TPayload;
}

export interface CreateEventInput<TPayload> {
  type: string;
  payload: TPayload;
  version?: number;
  workspaceId?: string;
  entityId?: string;
  idempotencyKey?: string;
}

/**
 * Fills in id/occurredAt/correlationId (from the ambient RequestContext,
 * when called within a request) so producers only supply what's
 * meaningful to them.
 */
export function createEvent<TPayload>(input: CreateEventInput<TPayload>): DomainEvent<TPayload> {
  const context = RequestContext.get();

  return {
    id: randomUUID(),
    type: input.type,
    version: input.version ?? 1,
    workspaceId: input.workspaceId ?? context?.workspaceId,
    entityId: input.entityId,
    occurredAt: new Date().toISOString(),
    correlationId: context?.correlationId,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
  };
}
