/**
 * Cursor-pagination response shape for collection endpoints handling
 * large/high-growth datasets, per "17. BRAYN Data & API Architecture"
 * and "23. BRAYN API Contracts" (Pagination). No collection endpoint
 * exists yet — Phase 2+ controllers return this shape rather than each
 * domain inventing its own.
 */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
