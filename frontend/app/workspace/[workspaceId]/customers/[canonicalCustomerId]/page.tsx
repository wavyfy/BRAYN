import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiErrorState } from '@/components/api-error-state';
import { RecalculateHealthButton } from './recalculate-health-button';
import { DetectOpportunitiesButton } from './detect-opportunities-button';
import { GenerateRecommendationsButton } from './generate-recommendations-button';
import { DismissRecommendationButton } from './dismiss-recommendation-button';

type CustomerRecord = {
  canonicalCustomerId: string;
  profile: { email: string | null; firstName: string | null; lastName: string | null; phone: string | null };
  sourceCustomers: { provider: string; externalId: string }[];
  commerceContext: {
    ordersCount: number;
    totalSpent: string;
    lastOrderAt: string | null;
    ordersLast90Days: number;
    recentOrders: { provider: string; externalId: string; totalPrice: string | null; createdAt: string }[];
  };
};

type ActivityEntry =
  | { type: 'customer_created'; occurredAt: string; provider: string; externalId: string }
  | { type: 'order_placed'; occurredAt: string; provider: string; externalId: string; totalPrice: string | null };

type HealthSignal = { available: boolean; value?: number | null; score?: number; reasonCode?: string; reason?: string };
type CustomerHealthState = {
  score: number | null;
  healthCategory: string | null;
  signals: Record<string, HealthSignal>;
  reasonCodes: string[];
  trend: string | null;
  lastCalculatedAt: string;
};

type RevenueOpportunity = {
  id: string;
  type: string;
  status: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  estimatedRevenue: string | null;
  confidence: number;
  reason: string;
  recommendedAction: string;
  createdAt: string;
};

type Recommendation = {
  id: string;
  text: string;
  state: 'active' | 'dismissed' | 'completed';
  supportingSignals: { opportunityType?: string; confidence?: number; priority?: string; reason?: string };
  createdAt: string;
};

const priorityStyles: Record<string, string> = {
  critical: 'bg-red-50 text-red-700 ring-red-600/20',
  high: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  medium: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  low: 'bg-slate-100 text-slate-700 ring-slate-500/20',
};

function customerName(customer: CustomerRecord): string {
  const name = [customer.profile.firstName, customer.profile.lastName].filter(Boolean).join(' ');
  return name || customer.profile.email || 'Unnamed customer';
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString() : '—';
}

/** Doc19 Phase 8 — canonical UI scope: profile, commerce summary, recent activity, risk/engagement, revenue opportunities. */
export default async function CustomerDetailPage({
  params,
}: {
  params: { workspaceId: string; canonicalCustomerId: string };
}) {
  const { workspaceId, canonicalCustomerId } = params;
  const base = `/api/v1/workspaces/${workspaceId}/customers/${canonicalCustomerId}`;

  let customer: CustomerRecord, activity: ActivityEntry[], opportunities: RevenueOpportunity[], recommendations: Recommendation[];
  try {
    [customer, activity, opportunities, recommendations] = await Promise.all([
      apiFetch(base),
      apiFetch(`${base}/activity`),
      apiFetch(`${base}/opportunities`),
      apiFetch(`${base}/recommendations`),
    ]);
  } catch (error) {
    if (error instanceof ApiError) {
      return (
        <ApiErrorState status={error.status} message={error.message} backHref={`/workspace/${workspaceId}/customers`} backLabel="Back to Customers" />
      );
    }
    throw error;
  }

  // Health is calculated on demand — "not yet calculated" (404) is an expected empty state, not a page-level error.
  let health: CustomerHealthState | null = null;
  try {
    health = await apiFetch(`${base}/health`);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) {
      throw error;
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link href={`/workspace/${workspaceId}/customers`} className="text-sm text-slate-500 hover:text-slate-700">
        &larr; Customers
      </Link>

      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">{customerName(customer)}</h1>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-slate-500">Email</dt>
              <dd className="mt-0.5 text-slate-900">{customer.profile.email ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Phone</dt>
              <dd className="mt-0.5 text-slate-900">{customer.profile.phone ?? '—'}</dd>
            </div>
          </dl>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {customer.sourceCustomers.map((source) => (
              <span key={`${source.provider}:${source.externalId}`} className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium capitalize text-slate-700 ring-1 ring-inset ring-slate-500/20">
                {source.provider}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Commerce summary</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-slate-500">Orders</dt>
              <dd className="mt-0.5 text-slate-900">{customer.commerceContext.ordersCount}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Total spent</dt>
              <dd className="mt-0.5 text-slate-900">{customer.commerceContext.totalSpent}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Last order</dt>
              <dd className="mt-0.5 text-slate-900">{formatDate(customer.commerceContext.lastOrderAt)}</dd>
            </div>
          </dl>
        </CardContent>
        {customer.commerceContext.recentOrders.length > 0 && (
          <ul className="divide-y divide-slate-200 border-t border-slate-200">
            {customer.commerceContext.recentOrders.map((order) => (
              <li key={`${order.provider}:${order.externalId}`} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <span className="text-slate-600">
                  Order <span className="font-mono text-xs">{order.externalId}</span> · {formatDate(order.createdAt)}
                </span>
                <span className="text-slate-900">{order.totalPrice ?? '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
        </CardHeader>
        {activity.length === 0 ? (
          <CardContent className="py-8 text-center text-sm text-slate-500">No activity yet.</CardContent>
        ) : (
          <ul className="divide-y divide-slate-200">
            {activity.map((entry) => (
              <li key={`${entry.type}:${entry.provider}:${entry.externalId}`} className="flex items-center justify-between gap-3 px-5 py-2.5 text-sm">
                <span className="text-slate-600">
                  {entry.type === 'customer_created' ? 'Connected' : 'Order placed'} via <span className="capitalize">{entry.provider}</span>
                </span>
                <span className="text-slate-500">{formatDate(entry.occurredAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Risk &amp; engagement</CardTitle>
        </CardHeader>
        <CardContent>
          {!health ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-slate-500">Not yet calculated for this customer.</p>
              <RecalculateHealthButton workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-500">
                  {health.score !== null ? `Score: ${health.score}/100` : 'Overall score withheld — see reasons below.'}
                </p>
                <RecalculateHealthButton workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} />
              </div>
              <ul className="space-y-1 text-sm text-slate-600">
                {health.reasonCodes.map((reasonCode) => (
                  <li key={reasonCode}>{reasonCode}</li>
                ))}
              </ul>
              <p className="text-xs text-slate-400">Last calculated {formatDate(health.lastCalculatedAt)}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Revenue opportunities</CardTitle>
        </CardHeader>
        <CardContent>
          {opportunities.length === 0 ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-slate-500">No open opportunities.</p>
              <DetectOpportunitiesButton workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} />
            </div>
          ) : (
            <div className="space-y-3">
              <DetectOpportunitiesButton workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} />
              <ul className="divide-y divide-slate-200">
                {opportunities.map((opportunity) => (
                  <li key={opportunity.id} className="py-3">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium capitalize text-slate-900">{opportunity.type.replace('_', ' ')}</span>
                      <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium capitalize ring-1 ring-inset ${priorityStyles[opportunity.priority] ?? priorityStyles.low}`}>
                        {opportunity.priority}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-slate-600">{opportunity.reason}</p>
                    <p className="mt-1 text-sm text-slate-900">{opportunity.recommendedAction}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recommendations</CardTitle>
        </CardHeader>
        <CardContent>
          {recommendations.length === 0 ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-slate-500">No active recommendations.</p>
              <GenerateRecommendationsButton workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} />
            </div>
          ) : (
            <div className="space-y-3">
              <GenerateRecommendationsButton workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} />
              <ul className="divide-y divide-slate-200">
                {recommendations.map((recommendation) => (
                  <li key={recommendation.id} className="flex items-start justify-between gap-3 py-3">
                    <div>
                      <p className="text-sm text-slate-900">{recommendation.text}</p>
                      {recommendation.supportingSignals.reason && (
                        <p className="mt-1 text-sm text-slate-600">{recommendation.supportingSignals.reason}</p>
                      )}
                    </div>
                    <DismissRecommendationButton workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} recommendationId={recommendation.id} />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
