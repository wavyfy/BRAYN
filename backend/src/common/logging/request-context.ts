import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextStore {
  correlationId: string;
  /** Set by AuthGuard once a session token is verified. */
  userId?: string;
  /**
   * Set once workspace membership can actually be resolved — requires the
   * Workspace domain (Phase 2) and Database Foundation (Step 5), neither
   * of which exist yet. The slot exists now so every log line already has
   * a place for it per "18. BRAYN Security, Observability & Reliability"
   * (Logging).
   */
  workspaceId?: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Ambient per-request context. Runs the given callback with the context
 * attached so any log call anywhere in the request's async chain can read
 * it without threading it through every function signature.
 *
 * See "18. BRAYN Security, Observability & Reliability" (Correlation &
 * Traceability).
 */
export const RequestContext = {
  run<T>(store: RequestContextStore, callback: () => T): T {
    return storage.run(store, callback);
  },

  /**
   * Attaches the context to the current async execution chain without a
   * wrapping callback. Used from Fastify's onRequest hook, whose
   * continuation (preHandler → route handler → onResponse) is a causal
   * descendant of that hook's invocation, so the context still propagates.
   */
  start(store: RequestContextStore): void {
    storage.enterWith(store);
  },

  /** Merges fields into the current store in place (e.g. after auth resolves). */
  update(patch: Partial<Omit<RequestContextStore, 'correlationId'>>): void {
    const current = storage.getStore();
    if (current) {
      Object.assign(current, patch);
    }
  },

  get(): RequestContextStore | undefined {
    return storage.getStore();
  },

  correlationId(): string | undefined {
    return storage.getStore()?.correlationId;
  },
};
