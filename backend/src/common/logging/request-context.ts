import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContextStore {
  correlationId: string;
}

const storage = new AsyncLocalStorage<RequestContextStore>();

/**
 * Ambient per-request context (correlation id today; workspace/user once
 * those domains exist). Runs the given callback with the context attached
 * so any log call anywhere in the request's async chain can read it
 * without threading it through every function signature.
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

  get(): RequestContextStore | undefined {
    return storage.getStore();
  },

  correlationId(): string | undefined {
    return storage.getStore()?.correlationId;
  },
};
