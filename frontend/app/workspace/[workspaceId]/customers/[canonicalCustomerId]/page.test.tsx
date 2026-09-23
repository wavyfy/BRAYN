/** @vitest-environment jsdom */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { ApiError } from '@/lib/api';
import CustomerDetailPage from './page';

type TestCustomer = {
  canonicalCustomerId: string;
  profile: { email: string | null; firstName: string | null; lastName: string | null; phone: string | null };
  sourceCustomers: { provider: string; externalId: string }[];
  commerceContext: { ordersCount: number; totalSpent: string; lastOrderAt: string | null; ordersLast90Days: number; recentOrders: unknown[] };
  behaviouralContext: { eventsCount: number; lastActivityAt: string | null; recentEvents: { eventType: string; occurredAt: string }[] };
};

const baseCustomer: TestCustomer = {
  canonicalCustomerId: 'cust_1',
  profile: { email: 'jane@example.com', firstName: 'Jane', lastName: 'Doe', phone: null },
  sourceCustomers: [{ provider: 'shopify', externalId: 'ext_1' }],
  commerceContext: { ordersCount: 0, totalSpent: '0', lastOrderAt: null, ordersLast90Days: 0, recentOrders: [] },
  behaviouralContext: { eventsCount: 0, lastActivityAt: null, recentEvents: [] },
};

function renderPage(customer: TestCustomer, activity: unknown[] = []) {
  apiFetch.mockResolvedValueOnce(customer); // customer
  apiFetch.mockResolvedValueOnce(activity); // activity
  apiFetch.mockResolvedValueOnce([]); // opportunities
  apiFetch.mockResolvedValueOnce([]); // recommendations
  apiFetch.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Not calculated yet.')); // health (not yet calculated)
  return CustomerDetailPage({ params: { workspaceId: 'ws_1', canonicalCustomerId: 'cust_1' } });
}

describe('CustomerDetailPage — Website Behaviour (Phase 8)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the empty website behaviour state when no behavioural data exists', async () => {
    render(await renderPage(baseCustomer));

    expect(screen.getByText('Website behaviour')).toBeTruthy();
    expect(screen.getAllByText('0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders events count, last activity, and recent website events when behavioural data exists', async () => {
    const customer = {
      ...baseCustomer,
      behaviouralContext: {
        eventsCount: 12,
        lastActivityAt: '2026-01-05T10:00:00.000Z',
        recentEvents: [{ eventType: 'product_view', occurredAt: '2026-01-05T10:00:00.000Z' }],
      },
    };

    render(await renderPage(customer));

    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('product view')).toBeTruthy();
  });

  it('renders website_activity entries within Customer Activity History, distinct from commerce entries', async () => {
    const activity = [
      { type: 'website_activity', occurredAt: '2026-01-06T00:00:00.000Z', eventType: 'cart' },
      { type: 'order_placed', occurredAt: '2026-01-05T00:00:00.000Z', provider: 'shopify', externalId: 'ext_1', totalPrice: '20.00' },
    ];

    render(await renderPage(baseCustomer, activity));

    expect(screen.getByText(/Website:/)).toBeTruthy();
    expect(screen.getByText('cart')).toBeTruthy();
    expect(screen.getByText(/Order placed via/)).toBeTruthy();
  });

  it('shows the "No activity yet" empty state when activity is empty, unaffected by an empty behavioural context', async () => {
    render(await renderPage(baseCustomer, []));

    expect(screen.getByText('No activity yet.')).toBeTruthy();
  });

  it('(1) renders the Ask BRAYN action', async () => {
    render(await renderPage(baseCustomer));

    expect(screen.getByRole('heading', { name: 'Ask BRAYN' })).toBeTruthy();
    expect(screen.getByLabelText('Ask a question about this customer')).toBeTruthy();
  });
});
