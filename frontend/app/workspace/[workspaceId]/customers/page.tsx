import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LinkButton } from '@/components/ui/link-button';
import { ApiErrorState } from '@/components/api-error-state';
import { PageBody, PageHeader } from '@/components/ui/page-header';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/empty-state';
import { ChevronRightIcon, SearchIcon } from '@/components/ui/icons';

type CustomerListItem = { canonicalCustomerId: string; email: string | null; firstName: string | null; lastName: string | null };
type CustomerListPage = { customers: CustomerListItem[]; page: number; limit: number; hasMore: boolean };

function customerName(customer: CustomerListItem): string {
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ');
  return name || customer.email || 'Unnamed customer';
}

/** Doc19 Phase 8 — canonical UI scope: "Customer list, Search/filter". Shows only what the list endpoint returns (identity + email). */
export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: { workspaceId: string };
  searchParams: { search?: string; page?: string };
}) {
  const search = searchParams.search ?? '';
  const page = Number(searchParams.page ?? '1') || 1;

  let result: CustomerListPage;
  try {
    const query = new URLSearchParams({ page: String(page) });
    if (search) query.set('search', search);
    result = await apiFetch(`/api/v1/workspaces/${params.workspaceId}/customers?${query.toString()}`);
  } catch (error) {
    if (error instanceof ApiError) {
      return <ApiErrorState status={error.status} message={error.message} backHref={`/workspace/${params.workspaceId}`} backLabel="Back to Workspace" />;
    }
    throw error;
  }

  const pageHref = (target: number) => `?${new URLSearchParams({ ...(search ? { search } : {}), page: String(target) }).toString()}`;

  return (
    <main>
      <PageHeader title="Customers" description="Every customer BRAYN has resolved across your connected sources." />

      <PageBody>
        <form method="GET" className="flex flex-wrap items-center gap-2" role="search">
          <div className="relative w-full max-w-sm">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input type="search" name="search" aria-label="Search customers by email" placeholder="Search by email…" defaultValue={search} className="pl-8" />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
          {search && (
            <Link href="?" className="text-[13px] text-muted-foreground hover:text-foreground">
              Clear
            </Link>
          )}
        </form>

        <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface shadow-panel">
          {result.customers.length === 0 ? (
            <EmptyState
              title={search ? 'No matches' : 'No customers yet'}
              message={search ? 'No customers match that search.' : 'No customers yet — connect an integration and run an import to get started.'}
              action={
                !search && (
                  <LinkButton href={`/workspace/${params.workspaceId}/integrations`} variant="secondary" size="sm">
                    Go to integrations
                  </LinkButton>
                )
              }
            />
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead className="border-b border-border bg-subtle text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">
                    Customer
                  </th>
                  <th scope="col" className="hidden px-4 py-2 font-medium sm:table-cell">
                    Email
                  </th>
                  <th scope="col" className="w-10 px-4 py-2">
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.customers.map((customer) => {
                  const href = `/workspace/${params.workspaceId}/customers/${customer.canonicalCustomerId}`;
                  return (
                    <tr key={customer.canonicalCustomerId} className="group relative transition-colors hover:bg-subtle/60">
                      <td className="px-4 py-2.5">
                        <Link href={href} className="flex items-center gap-3 font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-focus/40">
                          <Avatar name={customerName(customer)} size="sm" />
                          <span className="truncate">{customerName(customer)}</span>
                        </Link>
                      </td>
                      <td className="hidden px-4 py-2.5 text-muted-foreground sm:table-cell">{customer.email && <span className="truncate">{customer.email}</span>}</td>
                      <td className="px-4 py-2.5 text-right">
                        <ChevronRightIcon className="ml-auto h-4 w-4 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {(page > 1 || result.hasMore) && (
            <div className="flex items-center justify-between border-t border-border bg-subtle/40 px-4 py-2">
              <span className="text-xs tabular-nums text-muted-foreground">Page {page}</span>
              <div className="flex items-center gap-2">
                <LinkButton
                  href={pageHref(page - 1)}
                  variant="secondary"
                  size="sm"
                  aria-disabled={page <= 1}
                  className={page <= 1 ? 'pointer-events-none opacity-50' : undefined}
                >
                  &larr; Previous
                </LinkButton>
                <LinkButton
                  href={pageHref(page + 1)}
                  variant="secondary"
                  size="sm"
                  aria-disabled={!result.hasMore}
                  className={!result.hasMore ? 'pointer-events-none opacity-50' : undefined}
                >
                  Next &rarr;
                </LinkButton>
              </div>
            </div>
          )}
        </div>
      </PageBody>
    </main>
  );
}
