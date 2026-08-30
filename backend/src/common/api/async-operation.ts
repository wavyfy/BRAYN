/**
 * Reference returned by a long-running operation instead of blocking the
 * request, per "23. BRAYN API Contracts" (Async Operations) — e.g. large
 * imports, synchronization, knowledge processing. No async endpoint
 * exists yet; ready for the domain that first needs one.
 */
export interface AsyncOperationRef {
  operationId: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed';
}
