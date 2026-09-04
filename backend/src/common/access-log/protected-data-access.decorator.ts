import { SetMetadata } from '@nestjs/common';

export const PROTECTED_DATA_ACCESS_KEY = 'protectedDataAccess';

export type ProtectedResourceType = 'customer' | 'customer_activity' | 'conversation' | 'identity_duplicate';

export interface ProtectedDataAccessMeta {
  resourceType: ProtectedResourceType;
  /** Name of the route param carrying the resource's id (e.g. 'canonicalCustomerId'). Omit for list-level routes with no single target — resourceId is recorded as null. */
  resourceIdParam?: string;
}

/**
 * Marks a route as one that returns customer personal data, so
 * `ProtectedDataAccessInterceptor` records who accessed it (Shopify
 * Protected Customer Data — "do you log access to personal data?").
 * Metadata-only, read via `Reflector`, same pattern as
 * `RequireWorkspaceRole`/`WORKSPACE_ROLES_KEY` — this decorator carries
 * no behavior of its own.
 *
 * Must be paired with a route already gated by
 * `WorkspaceMembershipGuard` (Part 2's owner/admin restriction) — this
 * decorator only says "log this," not "who may access this."
 */
export const LogsProtectedAccess = (resourceType: ProtectedResourceType, resourceIdParam?: string) =>
  SetMetadata(PROTECTED_DATA_ACCESS_KEY, { resourceType, resourceIdParam } satisfies ProtectedDataAccessMeta);
