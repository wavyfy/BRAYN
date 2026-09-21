/** @vitest-environment jsdom */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch };
});

import { ApiError } from '@/lib/api';
import CustomersPage from './page';

describe('CustomersPage', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('lists customers with name/email and searches by the given query', async () => {
    apiFetch.mockResolvedValueOnce({
      customers: [{ canonicalCustomerId: 'cust_1', email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' }],
      page: 1,
      limit: 20,
      hasMore: false,
    });

    render(await CustomersPage({ params: { workspaceId: 'ws_1' }, searchParams: { search: 'jane' } }));

    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('search=jane'));
    expect(screen.getByText('Jane Doe')).toBeTruthy();
    expect(screen.getByText('jane@example.com')).toBeTruthy();
    expect((screen.getByPlaceholderText('Search by email…') as HTMLInputElement).value).toBe('jane');
  });

  it('renders Previous/Next pagination controls reflecting the current page and hasMore', async () => {
    apiFetch.mockResolvedValueOnce({
      customers: [{ canonicalCustomerId: 'cust_1', email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe' }],
      page: 2,
      limit: 20,
      hasMore: true,
    });

    render(await CustomersPage({ params: { workspaceId: 'ws_1' }, searchParams: { page: '2' } }));

    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('page=2'));
    const previous = screen.getByRole('link', { name: /Previous/ });
    const next = screen.getByRole('link', { name: /Next/ });
    expect(previous.getAttribute('href')).toContain('page=1');
    expect(previous.getAttribute('aria-disabled')).toBe('false');
    expect(next.getAttribute('href')).toContain('page=3');
    expect(next.getAttribute('aria-disabled')).toBe('false');
  });

  it('hides pagination controls entirely on page 1 with no more data', async () => {
    apiFetch.mockResolvedValueOnce({
      customers: [{ canonicalCustomerId: 'cust_1', email: 'jane@example.com', firstName: null, lastName: null }],
      page: 1,
      limit: 20,
      hasMore: false,
    });

    render(await CustomersPage({ params: { workspaceId: 'ws_1' }, searchParams: {} }));

    expect(screen.queryByRole('link', { name: /Previous/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /Next/ })).toBeNull();
  });

  it('renders the no-customers empty state when the workspace has no customers and no search is active', async () => {
    apiFetch.mockResolvedValueOnce({ customers: [], page: 1, limit: 20, hasMore: false });

    render(await CustomersPage({ params: { workspaceId: 'ws_1' }, searchParams: {} }));

    expect(screen.getByText('No customers yet — connect an integration and run an import to get started.')).toBeTruthy();
  });

  it('renders the no-search-results empty state when a search returns nothing', async () => {
    apiFetch.mockResolvedValueOnce({ customers: [], page: 1, limit: 20, hasMore: false });

    render(await CustomersPage({ params: { workspaceId: 'ws_1' }, searchParams: { search: 'nobody' } }));

    expect(screen.getByText('No customers match that search.')).toBeTruthy();
  });

  it('renders the inline API error state instead of crashing when the request fails', async () => {
    apiFetch.mockRejectedValueOnce(new ApiError(403, 'UNAUTHORIZED', 'Your role does not permit this action.'));

    render(await CustomersPage({ params: { workspaceId: 'ws_1' }, searchParams: {} }));

    expect(screen.getByText('Access denied')).toBeTruthy();
    expect(screen.getByText('Your role does not permit this action.')).toBeTruthy();
  });
});
