/** @vitest-environment jsdom */
import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, apiFetch };
});
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { ApiError } from '@/lib/api';
import CustomerDetailPage from './page';

// The memory, preferences and summary sections are fetched after the positional mocks each test queues; default them to empty.
beforeEach(() => {
  apiFetch.mockResolvedValue([]);
});

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

  it('renders the compact website behaviour summary (events count + last activity) when behavioural data exists', async () => {
    const customer = {
      ...baseCustomer,
      behaviouralContext: {
        eventsCount: 12,
        lastActivityAt: '2026-01-05T10:00:00.000Z',
        recentEvents: [{ eventType: 'product_view', occurredAt: '2026-01-05T10:00:00.000Z' }],
      },
    };

    render(await renderPage(customer));

    expect(screen.getByText(/12 events?/)).toBeTruthy();
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

  it('renders order cancellation, refund and fulfillment entries in Customer Activity History', async () => {
    const activity = [
      { type: 'order_cancelled', occurredAt: '2026-01-08T00:00:00.000Z', provider: 'woocommerce', externalId: 'ext_2' },
      { type: 'refund_processed', occurredAt: '2026-01-07T00:00:00.000Z', provider: 'shopify', externalId: 'r_1', orderExternalId: 'ext_1', totalRefunded: '20.00' },
      { type: 'fulfillment', occurredAt: '2026-01-06T00:00:00.000Z', provider: 'shopify', externalId: 'f_1', orderExternalId: 'ext_1', status: 'success', shipmentStatus: 'in_transit' },
    ];

    render(await renderPage(baseCustomer, activity));

    expect(screen.getByText(/Order cancelled in/)).toBeTruthy();
    expect(screen.getByText(/Refund processed/)).toBeTruthy();
    expect(screen.getByText('in transit')).toBeTruthy();
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

describe('CustomerDetailPage — Risk & engagement (Phase 3 CIV redesign)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows an honest withheld state, never a fake score, when health has not been calculated yet', async () => {
    render(await renderPage(baseCustomer));

    expect(screen.getByText('Not yet calculated for this customer.')).toBeTruthy();
    expect(screen.queryByText('Score withheld')).toBeNull(); // that copy belongs to a *calculated-but-withheld* score, a different state
  });

  it('shows the withheld-score state (not a fake score) when health is calculated but score/category/trend are null (Phase 7 partial signal coverage)', async () => {
    apiFetch.mockResolvedValueOnce(baseCustomer); // customer
    apiFetch.mockResolvedValueOnce([]); // activity
    apiFetch.mockResolvedValueOnce([]); // opportunities
    apiFetch.mockResolvedValueOnce([]); // recommendations
    apiFetch.mockResolvedValueOnce({
      score: null,
      healthCategory: null,
      signals: {},
      reasonCodes: ['Overall score withheld — only 65% of signal weight is available.'],
      trend: null,
      lastCalculatedAt: '2026-01-05T10:00:00.000Z',
    }); // health

    render(await CustomerDetailPage({ params: { workspaceId: 'ws_1', canonicalCustomerId: 'cust_1' } }));

    expect(screen.getByText('Score withheld')).toBeTruthy();
    expect(screen.getByText('Overall score withheld — only 65% of signal weight is available.')).toBeTruthy();
  });

  it('renders the numeric score when health is fully calculated', async () => {
    apiFetch.mockResolvedValueOnce(baseCustomer);
    apiFetch.mockResolvedValueOnce([]);
    apiFetch.mockResolvedValueOnce([]);
    apiFetch.mockResolvedValueOnce([]);
    apiFetch.mockResolvedValueOnce({
      score: 82,
      healthCategory: 'healthy',
      signals: {},
      reasonCodes: [],
      trend: 'improving',
      lastCalculatedAt: '2026-01-05T10:00:00.000Z',
    });

    render(await CustomerDetailPage({ params: { workspaceId: 'ws_1', canonicalCustomerId: 'cust_1' } }));

    expect(screen.getByText('82/100')).toBeTruthy();
    expect(screen.getByText(/Trend: improving/)).toBeTruthy();
  });
});

describe('CustomerDetailPage — Activity dedup (Phase 3 CIV redesign)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the order total within the unified Activity entry — no information lost by dropping the separate recent-orders list', async () => {
    const activity = [{ type: 'order_placed', occurredAt: '2026-01-05T00:00:00.000Z', provider: 'shopify', externalId: 'ext_1', totalPrice: '49.99' }];

    render(await renderPage(baseCustomer, activity));

    expect(screen.getByText(/49\.99/)).toBeTruthy();
  });
});

describe('CustomerDetailPage — Revenue opportunities & risk (Phase 6)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  const opportunity = (overrides: Record<string, unknown>) => ({
    id: 'opp_1',
    type: 'upsell',
    status: 'new',
    priority: 'medium',
    estimatedRevenue: '28.00',
    confidence: 80,
    reason: 'Customer purchased a 48.00 variant; a 76.00 variant is available.',
    recommendedAction: 'Suggest the higher-tier variant to this customer.',
    createdAt: '2026-01-05T00:00:00.000Z',
    ...overrides,
  });

  const recommendationFor = (sourceOpportunityId: string, text: string, overrides: Record<string, unknown> = {}) => ({
    id: `rec_${sourceOpportunityId}`,
    sourceOpportunityId,
    text,
    state: 'active',
    supportingSignals: {},
    createdAt: '2026-01-05T00:00:00.000Z',
    ...overrides,
  });

  const withheldHealth = {
    score: null,
    healthCategory: null,
    signals: {
      purchaseRecency: { weight: 30, available: true, value: 9, score: 90, reasonCode: 'Last order 9 day(s) ago — recency score 90/100.' },
      purchaseFrequency: { weight: 20, available: true, value: 4, score: 100, reasonCode: '4 order(s) in last 90 days — frequency score 100/100.' },
      websiteEngagement: { weight: 15, available: true, value: 11, score: 78, reasonCode: '11 website event(s) recorded.' },
      whatsappEngagement: { weight: 15, available: false, reason: 'Conversation domain not built yet.' },
      emailEngagement: { weight: 10, available: false, reason: 'Pending product decision.' },
      customerExperience: { weight: 10, available: false, reason: 'No source defined yet.' },
    },
    reasonCodes: ['Overall score withheld — only 65% of signal weight is available.'],
    trend: null,
    lastCalculatedAt: '2026-01-05T10:00:00.000Z',
  };

  async function renderWith({
    opportunities = [] as unknown,
    recommendations = [] as unknown,
    health = null as unknown,
    opportunitiesError = false,
  }) {
    apiFetch.mockResolvedValueOnce(baseCustomer);
    apiFetch.mockResolvedValueOnce([]);
    if (opportunitiesError) apiFetch.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'Detector unavailable.'));
    else apiFetch.mockResolvedValueOnce(opportunities);
    apiFetch.mockResolvedValueOnce(recommendations);
    if (health) apiFetch.mockResolvedValueOnce(health);
    else apiFetch.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'Not calculated yet.'));
    render(await CustomerDetailPage({ params: { workspaceId: 'ws_1', canonicalCustomerId: 'cust_1' } }));
  }

  it('orders opportunities by priority and shows each linked recommendation once, as its next step', async () => {
    await renderWith({
      opportunities: [
        opportunity({ id: 'opp_low', type: 'upsell', priority: 'medium' }),
        opportunity({ id: 'opp_vip', type: 'vip_recognition', priority: 'critical', estimatedRevenue: null, reason: 'Customer has placed 12 orders.', recommendedAction: 'Recognize this customer with a VIP perk.' }),
      ],
      recommendations: [recommendationFor('opp_vip', 'Recognize this customer with a VIP perk.')],
    });

    const titles = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent);
    expect(titles).toEqual(['VIP recognition', 'Upsell']);
    expect(screen.getByText('2 open')).toBeTruthy();
    expect(screen.getAllByText('Recognize this customer with a VIP perk.')).toHaveLength(1);
    expect(screen.getByText('Recommended next step')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
  });

  it('shows estimated revenue only when the backend returns one', async () => {
    await renderWith({ opportunities: [opportunity({ id: 'opp_1', estimatedRevenue: null })] });

    expect(screen.queryByText('Est. revenue')).toBeNull();
    expect(screen.getByText('80% confidence')).toBeTruthy();
  });

  it('labels an opportunity without a recommendation as a suggested action and offers to generate recommendations', async () => {
    await renderWith({ opportunities: [opportunity({})] });

    expect(screen.getByText('Suggested action')).toBeTruthy();
    expect(screen.getByText('28.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate recommendations' })).toBeTruthy();
  });

  it('shows an honest empty state with detection still available when there are no opportunities', async () => {
    await renderWith({});

    expect(screen.getByText('No open opportunities for this customer right now.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Detect opportunities' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate recommendations' })).toBeNull();
  });

  it('keeps an active recommendation whose opportunity is no longer open, under other recommendations', async () => {
    await renderWith({ recommendations: [recommendationFor('opp_closed', 'Send a win-back offer.', { supportingSignals: { priority: 'high' } })] });

    expect(screen.getByText('Other recommendations')).toBeTruthy();
    expect(screen.getByText('Send a win-back offer.')).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();
  });

  it('renders the rest of the page with an inline error when opportunities fail to load', async () => {
    await renderWith({ opportunitiesError: true });

    expect(screen.getByRole('alert').textContent).toContain('Detector unavailable.');
    expect(screen.getByRole('heading', { name: 'Risk & engagement' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
  });

  it('breaks the withheld score down into the backend signals, with coverage summed from the backend weights', async () => {
    await renderWith({ health: withheldHealth });

    expect(screen.getByText('Score withheld')).toBeTruthy();
    expect(screen.getByText('65%')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Purchase recency score' }).getAttribute('aria-valuenow')).toBe('90');
    expect(screen.getAllByRole('meter')).toHaveLength(3);
    expect(screen.getAllByText('Not available yet')).toHaveLength(3);
    // Per-signal reasons replace the flat reason list — nothing is shown twice.
    expect(screen.queryByText('Overall score withheld — only 65% of signal weight is available.')).toBeNull();
  });

  it('passes the page\'s real customer context into Ask BRAYN', async () => {
    await renderWith({ opportunities: [opportunity({ id: 'opp_1' })], recommendations: [recommendationFor('opp_1', 'Suggest the higher-tier variant to this customer.')] });

    expect(screen.getByText('Answering about')).toBeTruthy();
    expect(screen.getAllByText('Jane Doe').length).toBe(2); // page title + Ask BRAYN context
    expect(screen.getByText('1 open revenue opportunity')).toBeTruthy();
    expect(screen.getByText('1 active recommendation')).toBeTruthy();
    expect(screen.getByText('Risk & engagement state (not calculated yet)')).toBeTruthy();
  });

  it('renders a numeric score with the category the backend provides, and no invented trend', async () => {
    await renderWith({ health: { ...withheldHealth, score: 82, healthCategory: 'healthy' } });

    expect(screen.getByText('82/100')).toBeTruthy();
    expect(screen.getByText('healthy')).toBeTruthy();
    expect(screen.queryByText(/Trend:/)).toBeNull();
  });
});

describe('CustomerDetailPage — Customer memory (Slice 4.1)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('fetches the memory endpoint and renders each note with its provenance', async () => {
    const page = renderPage(baseCustomer);
    apiFetch.mockResolvedValueOnce([
      { id: 'm1', content: 'Prefers weekend delivery', provenance: 'merchant_provided', createdAt: '2026-01-05T10:00:00.000Z', updatedAt: '2026-01-05T10:00:00.000Z' },
    ]);
    render(await page);

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/workspaces/ws_1/customers/cust_1/memory');
    expect(screen.getByText('Memory')).toBeTruthy();
    expect(screen.getByText('Prefers weekend delivery')).toBeTruthy();
    expect(screen.getByText(/Added by your team/)).toBeTruthy();
  });

  it('shows an empty state when the customer has no notes', async () => {
    render(await renderPage(baseCustomer));
    expect(screen.getByText('No notes yet.')).toBeTruthy();
  });

  it('keeps the rest of the page and shows an inline error when memory fails to load', async () => {
    const page = renderPage(baseCustomer);
    apiFetch.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'Memory unavailable.'));
    render(await page);

    expect(screen.getByText('Memory could not be loaded: Memory unavailable.')).toBeTruthy();
    expect(screen.getByText('Activity')).toBeTruthy();
  });
});

describe('CustomerDetailPage — Customer preferences (Slice 4.2)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('fetches the preferences endpoint and renders each preference with its category and provenance', async () => {
    const page = renderPage(baseCustomer);
    apiFetch.mockResolvedValueOnce([]); // memory
    apiFetch.mockResolvedValueOnce([
      { id: 'p1', category: 'communication', content: 'Prefers email over SMS', provenance: 'merchant_provided', createdAt: '2026-01-05T10:00:00.000Z', updatedAt: '2026-01-05T10:00:00.000Z' },
    ]);
    render(await page);

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/workspaces/ws_1/customers/cust_1/preferences');
    expect(screen.getByText('Preferences')).toBeTruthy();
    expect(screen.getByText('Prefers email over SMS')).toBeTruthy();
    expect(screen.getByText('Communication', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText(/Added by your team/)).toBeTruthy();
  });

  it('shows an empty state when the customer has no preferences', async () => {
    render(await renderPage(baseCustomer));
    expect(screen.getByText('No preferences recorded yet.')).toBeTruthy();
  });

  it('keeps the rest of the page and shows an inline error when preferences fail to load', async () => {
    const page = renderPage(baseCustomer);
    apiFetch.mockResolvedValueOnce([]); // memory
    apiFetch.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'Preferences unavailable.'));
    render(await page);

    expect(screen.getByText('Preferences could not be loaded: Preferences unavailable.')).toBeTruthy();
    expect(screen.getByText('No notes yet.')).toBeTruthy();
  });
});

describe('CustomerDetailPage — Customer summary (Slice 4.5)', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function queueSummary(page: ReturnType<typeof renderPage>, summary: unknown) {
    apiFetch.mockResolvedValueOnce([]); // memory
    apiFetch.mockResolvedValueOnce([]); // preferences
    if (summary instanceof Error) apiFetch.mockRejectedValueOnce(summary);
    else apiFetch.mockResolvedValueOnce(summary);
    return page;
  }

  it('fetches the summary endpoint and renders the text with its AI-generated label', async () => {
    const page = queueSummary(renderPage(baseCustomer), {
      summary: { content: 'A loyal repeat buyer.', provenance: 'ai_generated', model: 'm', generatedAt: '2026-01-05T10:00:00.000Z', generatedByUserId: 'u1' },
      stale: false,
    });
    render(await page);

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/workspaces/ws_1/customers/cust_1/summary');
    expect(screen.getByText('A loyal repeat buyer.')).toBeTruthy();
    expect(screen.getByText(/AI-generated · may be outdated/)).toBeTruthy();
    expect(screen.queryByText('Data changed since this summary')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('shows the stale badge when the data changed since the summary', async () => {
    const page = queueSummary(renderPage(baseCustomer), {
      summary: { content: 'Old summary.', provenance: 'ai_generated', model: 'm', generatedAt: '2026-01-05T10:00:00.000Z', generatedByUserId: 'u1' },
      stale: true,
    });
    render(await page);
    expect(screen.getByText('Data changed since this summary')).toBeTruthy();
  });

  it('shows an empty state with a Generate button when there is no summary yet', async () => {
    render(await queueSummary(renderPage(baseCustomer), { summary: null, stale: false }));
    expect(screen.getByText(/No summary yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Generate' })).toBeTruthy();
  });

  it('keeps the rest of the page and shows an inline error when the summary fails to load', async () => {
    render(await queueSummary(renderPage(baseCustomer), new ApiError(500, 'INTERNAL', 'Summary unavailable.')));
    expect(screen.getByText('Summary could not be loaded: Summary unavailable.')).toBeTruthy();
    expect(screen.getByText('Activity')).toBeTruthy();
  });
});
