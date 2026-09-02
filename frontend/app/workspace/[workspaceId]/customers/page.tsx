import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LinkButton } from '@/components/ui/link-button';
import { ApiErrorState } from '@/components/api-error-state';

type CustomerListItem = { canonicalCustomerId: string; email: string | null; firstName: string | null; lastName: string | null };
type CustomerListPage = { customers: CustomerListItem[]; page: number; limit: number; hasMore: boolean };

function customerName(customer: CustomerListItem): string {
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(' ');
  return name || customer.email || 'Unnamed customer';
}

/** Doc19 Phase 8 — canonical UI scope: "Customer list, Search/filter". */
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

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link href={`/workspace/${params.workspaceId}`} className="text-sm text-slate-500 hover:text-slate-700">
        &larr; Workspace
      </Link>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">Customers</h1>

      <form method="GET" className="mt-6 flex gap-2">
        <Input type="search" name="search" placeholder="Search by email…" defaultValue={search} className="max-w-sm" />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      <Card className="mt-4">
        {result.customers.length === 0 ? (
          <CardContent className="py-12 text-center text-sm text-slate-500">
            {search ? 'No customers match that search.' : 'No customers yet — connect an integration and run an import to get started.'}
          </CardContent>
        ) : (
          <ul className="divide-y divide-slate-200">
            {result.customers.map((customer) => (
              <li key={customer.canonicalCustomerId}>
                <Link
                  href={`/workspace/${params.workspaceId}/customers/${customer.canonicalCustomerId}`}
                  className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-slate-50"
                >
                  <span className="truncate text-sm font-medium text-slate-900">{customerName(customer)}</span>
                  {customer.email && <span className="truncate text-sm text-slate-500">{customer.email}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {(page > 1 || result.hasMore) && (
        <div className="mt-4 flex items-center justify-between">
          <LinkButton
            href={`?${new URLSearchParams({ ...(search ? { search } : {}), page: String(page - 1) }).toString()}`}
            variant="secondary"
            size="sm"
            aria-disabled={page <= 1}
            className={page <= 1 ? 'pointer-events-none opacity-50' : undefined}
          >
            &larr; Previous
          </LinkButton>
          <span className="text-sm text-slate-500">Page {page}</span>
          <LinkButton
            href={`?${new URLSearchParams({ ...(search ? { search } : {}), page: String(page + 1) }).toString()}`}
            variant="secondary"
            size="sm"
            aria-disabled={!result.hasMore}
            className={!result.hasMore ? 'pointer-events-none opacity-50' : undefined}
          >
            Next &rarr;
          </LinkButton>
        </div>
      )}
    </main>
  );
}
