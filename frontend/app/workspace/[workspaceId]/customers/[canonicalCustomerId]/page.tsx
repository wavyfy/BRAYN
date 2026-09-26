import { apiFetch, ApiError } from '@/lib/api';
import { ApiErrorState } from '@/components/api-error-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { ErrorText } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Metric, MetricStrip } from '@/components/ui/metric';
import { SectionHeader } from '@/components/ui/section';
import { formatDateTime, formatRelative, providerLabel } from '@/lib/format';
import { RecalculateHealthButton } from './recalculate-health-button';
import { DetectOpportunitiesButton } from './detect-opportunities-button';
import { GenerateRecommendationsButton } from './generate-recommendations-button';
import { AskBraynCard } from './ask-brayn-card';
import { ActivityTimeline, type ActivityEntry } from './activity-timeline';
import { RiskEngagement, type CustomerHealthState } from './risk-engagement';
import { RevenueOpportunities, type RevenueOpportunity, type Recommendation } from './revenue-opportunities';

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
  behaviouralContext: {
    eventsCount: number;
    lastActivityAt: string | null;
    recentEvents: { eventType: string; occurredAt: string }[];
  };
};

type SectionResult<T> = { ok: true; data: T } | { ok: false; message: string };

/** A section-level fetch: an expected API error becomes an inline message for that section instead of failing the whole page. */
async function fetchSection<T>(path: string): Promise<SectionResult<T>> {
  try {
    return { ok: true, data: (await apiFetch(path)) as T };
  } catch (error) {
    if (error instanceof ApiError) return { ok: false, message: error.message };
    throw error;
  }
}

function customerName(customer: CustomerRecord): string {
  const name = [customer.profile.firstName, customer.profile.lastName].filter(Boolean).join(' ');
  return name || customer.profile.email || 'Unnamed customer';
}

function contactLine(customer: CustomerRecord): string | undefined {
  const parts = [customer.profile.email, customer.profile.phone].filter((v): v is string => Boolean(v));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Relative time for scanning, exact time on hover; "—" when there's nothing to date. */
function When({ value }: { value: string | null }) {
  if (!value) return <>—</>;
  return <span title={formatDateTime(value)}>{formatRelative(value)}</span>;
}

/**
 * Doc19 Phase 8 / doc11 Customer Intelligence View — a customer intelligence
 * workspace. Identity + key metrics lead; the main column holds what BRAYN
 * found and what to do (revenue opportunities, then Ask BRAYN); the right
 * rail holds the context behind it (Risk & Engagement State, then the
 * customer's activity journey).
 */
export default async function CustomerDetailPage({
  params,
}: {
  params: { workspaceId: string; canonicalCustomerId: string };
}) {
  const { workspaceId, canonicalCustomerId } = params;
  const base = `/api/v1/workspaces/${workspaceId}/customers/${canonicalCustomerId}`;

  let customer: CustomerRecord, activity: ActivityEntry[];
  let opportunitiesResult: SectionResult<RevenueOpportunity[]>, recommendationsResult: SectionResult<Recommendation[]>;
  try {
    [customer, activity, opportunitiesResult, recommendationsResult] = await Promise.all([
      apiFetch(base),
      apiFetch(`${base}/activity`),
      fetchSection<RevenueOpportunity[]>(`${base}/opportunities`),
      fetchSection<Recommendation[]>(`${base}/recommendations`),
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

  const opportunities = opportunitiesResult.ok ? opportunitiesResult.data : [];
  const recommendations = recommendationsResult.ok ? recommendationsResult.data : [];
  const recommendedIds = new Set(recommendations.map((recommendation) => recommendation.sourceOpportunityId));
  const needsRecommendations = recommendationsResult.ok && opportunities.some((opportunity) => !recommendedIds.has(opportunity.id));
  const { commerceContext, behaviouralContext } = customer;
  const name = customerName(customer);
  const contact = contactLine(customer);

  return (
    <main>
      {/* Identity + key metrics. No back-link: the workspace shell's Customers nav item already provides that. */}
      <header className="border-b border-border bg-surface px-6 pb-5 pt-5 lg:px-8">
        <div className="flex flex-wrap items-center gap-3.5">
          <Avatar name={name} size="lg" />
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{name}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground">
              {contact && <span>{contact}</span>}
              {customer.sourceCustomers.map((source) => (
                <StatusBadge key={`${source.provider}:${source.externalId}`} tone="neutral">
                  {providerLabel(source.provider)}
                </StatusBadge>
              ))}
            </div>
          </div>
        </div>

        <MetricStrip className="mt-5">
          <Metric label="Total spent" value={commerceContext.totalSpent} />
          <Metric label="Orders" value={commerceContext.ordersCount} hint={`${commerceContext.ordersLast90Days} in the last 90 days`} />
          <Metric label="Last order" value={<When value={commerceContext.lastOrderAt} />} />
          <Metric
            label="Open opportunities"
            value={opportunitiesResult.ok ? opportunities.length : '—'}
            hint={recommendationsResult.ok && recommendations.length > 0 ? `${recommendations.length} with a recommendation` : undefined}
          />
          <Metric
            label="Website behaviour"
            value={`${behaviouralContext.eventsCount} event${behaviouralContext.eventsCount === 1 ? '' : 's'}`}
            hint={
              <>
                Last active <When value={behaviouralContext.lastActivityAt} />
              </>
            }
          />
        </MetricStrip>
      </header>

      <div className="grid grid-cols-1 items-start gap-8 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-8 xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* Primary — what BRAYN found, what to do about it, and the analyst to ask why. */}
        <div className="min-w-0 space-y-8">
          <section>
            <SectionHeader
              title="Revenue opportunities"
              count={opportunitiesResult.ok && opportunities.length > 0 ? `${opportunities.length} open` : undefined}
              action={
                <>
                  {needsRecommendations && <GenerateRecommendationsButton workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} />}
                  <DetectOpportunitiesButton workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} />
                </>
              }
            />
            <div className="mt-3">
              {!opportunitiesResult.ok ? (
                <ErrorText className="rounded-xl border border-danger/20 bg-danger/[0.03] px-4 py-3">
                  Opportunities could not be loaded: {opportunitiesResult.message}
                </ErrorText>
              ) : (
                <>
                  {!recommendationsResult.ok && <ErrorText className="mb-3">Recommendations could not be loaded: {recommendationsResult.message}</ErrorText>}
                  <RevenueOpportunities
                    workspaceId={workspaceId}
                    canonicalCustomerId={canonicalCustomerId}
                    opportunities={opportunities}
                    recommendations={recommendations}
                  />
                </>
              )}
            </div>
          </section>

          <section aria-labelledby="ask-brayn-heading">
            <AskBraynCard
              workspaceId={workspaceId}
              canonicalCustomerId={canonicalCustomerId}
              context={{
                customerName: name,
                healthCalculated: health !== null,
                openOpportunities: opportunitiesResult.ok ? opportunities.length : null,
                activeRecommendations: recommendationsResult.ok ? recommendations.length : null,
              }}
            />
          </section>
        </div>

        {/* Context rail — the customer's current state, then the journey behind it. */}
        <aside className="min-w-0 space-y-8">
          <section>
            <SectionHeader title="Risk & engagement" action={<RecalculateHealthButton workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} />} />
            <div className="mt-3 rounded-xl border border-border bg-surface shadow-panel p-4">
              <RiskEngagement health={health} />
            </div>
          </section>

          <section>
            <SectionHeader title="Activity" count={activity.length > 0 ? activity.length : undefined} />
            <div className="mt-3">
              <ActivityTimeline activity={activity} />
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
