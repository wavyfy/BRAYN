import type { CustomerService } from '../commerce/customer.service';
import type { NormalizedOrder } from '../commerce/order.service';
import type { IdentityResolutionService } from '../identity-resolution/identity-resolution.service';
import type { IntegrationProvider } from './dto/connect-integration.schema';

/**
 * Upserts and resolves the guest-checkout source customers a batch of orders carries (`NormalizedOrder.guestCustomer`),
 * through the same CustomerService → IdentityResolutionService path as a provider's own customers, so the orders'
 * `customerExternalId` links when OrderService writes them. Call before `OrderService.upsertMany` on every order path
 * (import, sync, reconciliation, webhook). Idempotent; a no-op for a batch with no guests (every Shopify batch).
 */
export async function upsertGuestCustomers(
  customerService: CustomerService,
  identityResolutionService: IdentityResolutionService,
  workspaceId: string,
  integrationId: string,
  provider: IntegrationProvider,
  orders: NormalizedOrder[],
): Promise<void> {
  // One row per key: a page with repeat guest purchases would otherwise hit the same row twice in one ON CONFLICT insert.
  const guests = [...new Map(orders.flatMap((order) => (order.guestCustomer ? [[order.guestCustomer.externalId, order.guestCustomer] as const] : []))).values()];
  if (guests.length === 0) {
    return;
  }
  await customerService.upsertMany(workspaceId, integrationId, provider, guests);
  await identityResolutionService.resolveMany(workspaceId, provider, guests.map((guest) => guest.externalId));
}
