import { EmptyState } from '@/components/ui/empty-state';
import { PriorityBadge, type Priority } from '@/components/ui/priority-badge';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/lib/utils';
import { DismissRecommendationButton } from './dismiss-recommendation-button';

export type RevenueOpportunity = {
  id: string;
  type: string;
  status: string;
  priority: Priority;
  estimatedRevenue: string | null;
  confidence: number;
  reason: string;
  recommendedAction: string;
  createdAt: string;
};

export type Recommendation = {
  id: string;
  /** The opportunity this recommendation was generated from (1:1 — recommendations schema). */
  sourceOpportunityId: string;
  text: string;
  state: 'active' | 'dismissed' | 'completed';
  supportingSignals: { opportunityType?: string; confidence?: number; priority?: Priority; reason?: string };
  createdAt: string;
};

/** Display names for the types RevenueOpportunityService produces today; anything else falls back to its humanized name. */
const typeLabels: Record<string, string> = {
  reorder: 'Reorder',
  win_back: 'Win-back',
  vip_recognition: 'VIP recognition',
  cross_sell: 'Cross-sell',
  bundle: 'Bundle',
  upsell: 'Upsell',
};

export function opportunityTypeLabel(type: string): string {
  if (typeLabels[type]) return typeLabels[type];
  const words = type.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const priorityRank: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const priorityRailClass: Record<Priority, string> = {
  critical: 'bg-danger',
  high: 'bg-warning',
  medium: 'bg-info',
  low: 'bg-border-strong',
};

type SectionProps = {
  workspaceId: string;
  canonicalCustomerId: string;
  opportunities: RevenueOpportunity[];
  recommendations: Recommendation[];
};

function OpportunityRow({
  opportunity,
  recommendation,
  workspaceId,
  canonicalCustomerId,
}: {
  opportunity: RevenueOpportunity;
  recommendation: Recommendation | undefined;
  workspaceId: string;
  canonicalCustomerId: string;
}) {
  const label = opportunityTypeLabel(opportunity.type);
  const confidence = Math.max(0, Math.min(100, opportunity.confidence));

  return (
    <li className={cn('relative py-4 pl-6 pr-4', opportunity.priority === 'critical' && 'bg-danger/[0.025]')}>
      <span aria-hidden className={cn('absolute bottom-4 left-2.5 top-4 w-[3px] rounded-full', priorityRailClass[opportunity.priority])} />

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold tracking-tight text-foreground">{label}</h3>
            <PriorityBadge priority={opportunity.priority} />
            {/* 'new' is every opportunity's starting status — only a lifecycle change is worth a badge. */}
            {opportunity.status !== 'new' && (
              <StatusBadge tone="neutral" className="capitalize">
                {opportunity.status.replace(/_/g, ' ')}
              </StatusBadge>
            )}
          </div>
          <p className="mt-1 max-w-[68ch] text-[13px] leading-relaxed text-muted-foreground">{opportunity.reason}</p>
        </div>

        {opportunity.estimatedRevenue !== null && (
          <div className="shrink-0 text-right">
            <p className="text-lg font-semibold leading-tight tracking-tight tabular-nums text-foreground">{opportunity.estimatedRevenue}</p>
            <p className="text-xs text-muted-foreground">Est. revenue</p>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg bg-subtle/70 px-3 py-2">
        <div className="flex min-w-0 flex-col gap-0.5 text-[13px] sm:flex-row sm:items-baseline sm:gap-2">
          <span className="shrink-0 text-xs font-medium text-muted-foreground">{recommendation ? 'Recommended next step' : 'Suggested action'}</span>
          <span className="min-w-0 text-foreground">{recommendation ? recommendation.text : opportunity.recommendedAction}</span>
        </div>
        {recommendation && (
          <DismissRecommendationButton workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} recommendationId={recommendation.id} />
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <span aria-hidden className="h-1 w-10 overflow-hidden rounded-full bg-subtle">
          <span className="block h-full rounded-full bg-foreground/50" style={{ width: `${confidence}%` }} />
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">{opportunity.confidence}% confidence</span>
      </div>
    </li>
  );
}

/**
 * Revenue opportunities with their recommendations folded in — opportunity
 * first (what + why), its recommendation second (what to do), linked by
 * `sourceOpportunityId`. Ordered by priority, most urgent first. An active
 * recommendation whose opportunity is no longer open still shows, below.
 * Only renders fields the API returns; missing estimated revenue is simply
 * omitted.
 */
export function RevenueOpportunities({ workspaceId, canonicalCustomerId, opportunities, recommendations }: SectionProps) {
  const byOpportunity = new Map(recommendations.map((recommendation) => [recommendation.sourceOpportunityId, recommendation]));
  const openIds = new Set(opportunities.map((opportunity) => opportunity.id));
  const unlinked = recommendations.filter((recommendation) => !openIds.has(recommendation.sourceOpportunityId));
  const sorted = [...opportunities].sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);

  return (
    <div>
      {sorted.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border-strong">
          <EmptyState message="No open opportunities for this customer right now." className="py-8" />
        </div>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface shadow-panel">
          {sorted.map((opportunity) => (
            <OpportunityRow
              key={opportunity.id}
              opportunity={opportunity}
              recommendation={byOpportunity.get(opportunity.id)}
              workspaceId={workspaceId}
              canonicalCustomerId={canonicalCustomerId}
            />
          ))}
        </ul>
      )}

      {unlinked.length > 0 && (
        <div className="mt-4">
          <p className="text-[13px] font-medium text-foreground">Other recommendations</p>
          <ul className="mt-2 space-y-2">
            {unlinked.map((recommendation) => (
              <li key={recommendation.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-[13px]">
                <div className="min-w-0">
                  <p className="text-foreground">{recommendation.text}</p>
                  {recommendation.supportingSignals.reason && <p className="mt-0.5 text-muted-foreground">{recommendation.supportingSignals.reason}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {recommendation.supportingSignals.priority && <PriorityBadge priority={recommendation.supportingSignals.priority} />}
                  <DismissRecommendationButton workspaceId={workspaceId} canonicalCustomerId={canonicalCustomerId} recommendationId={recommendation.id} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
