import type { ComponentType, SVGProps } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { CursorIcon, OrderIcon, UserPlusIcon } from '@/components/ui/icons';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

export type ActivityEntry =
  | { type: 'customer_created'; occurredAt: string; provider: string; externalId: string }
  | { type: 'order_placed'; occurredAt: string; provider: string; externalId: string; totalPrice: string | null }
  | { type: 'website_activity'; occurredAt: string; eventType: string };

/** How many events show before the rest fold behind "Show earlier activity". */
const VISIBLE_EVENTS = 12;

function activityKey(entry: ActivityEntry): string {
  return entry.type === 'website_activity' ? `website_activity:${entry.eventType}:${entry.occurredAt}` : `${entry.type}:${entry.provider}:${entry.externalId}`;
}

const typeStyle: Record<ActivityEntry['type'], { icon: ComponentType<SVGProps<SVGSVGElement>>; className: string }> = {
  order_placed: { icon: OrderIcon, className: 'bg-success/10 text-success ring-success/20' },
  website_activity: { icon: CursorIcon, className: 'bg-info/10 text-info ring-info/20' },
  customer_created: { icon: UserPlusIcon, className: 'bg-subtle text-foreground/60 ring-border' },
};

function ActivityLabel({ entry }: { entry: ActivityEntry }) {
  switch (entry.type) {
    case 'website_activity':
      return (
        <span className="text-foreground">
          <span className="text-muted-foreground">Website: </span>
          <span className="capitalize">{entry.eventType.replace('_', ' ')}</span>
        </span>
      );
    case 'order_placed':
      return (
        <span className="text-foreground">
          Order placed via <span className="capitalize">{entry.provider}</span>
          {entry.totalPrice && <span className="font-semibold tabular-nums"> · {entry.totalPrice}</span>}
        </span>
      );
    case 'customer_created':
      return (
        <span className="text-foreground">
          Became a customer in <span className="capitalize">{entry.provider}</span>
        </span>
      );
  }
}

function monthLabel(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function Events({ entries, isLastGroup }: { entries: ActivityEntry[]; isLastGroup: boolean }) {
  let previousMonth: string | null = null;
  return (
    <ol className="relative">
      {entries.map((entry, index) => {
        const month = monthLabel(entry.occurredAt);
        const showMonth = month !== previousMonth;
        previousMonth = month;
        const { icon: Icon, className } = typeStyle[entry.type];
        const isLast = isLastGroup && index === entries.length - 1;
        return (
          <li key={activityKey(entry)}>
            {showMonth && <p className="pb-1.5 pt-3 text-xs font-medium text-muted-foreground first:pt-0">{month}</p>}
            <div className="relative flex gap-3 pb-3">
              {!isLast && <span aria-hidden className="absolute bottom-0 left-[11px] top-6 w-px bg-border" />}
              <span aria-hidden className={cn('relative z-[1] inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full ring-1 ring-inset', className)}>
                <Icon className="h-3 w-3" />
              </span>
              <div className="min-w-0 pt-0.5 text-[13px]">
                <ActivityLabel entry={entry} />
                <p className="text-xs text-muted-foreground">
                  <time dateTime={entry.occurredAt}>{formatDateTime(entry.occurredAt)}</time>
                </p>
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * doc08/doc11 Customer Activity History — one chronological journey, already
 * merged server-side (`getActivity()`); this only adds type-differentiated
 * presentation and month grouping. Older events fold behind a native
 * disclosure rather than a nested scroll area.
 */
export function ActivityTimeline({ activity }: { activity: ActivityEntry[] }) {
  if (activity.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border-strong">
        <EmptyState message="No activity yet." className="py-8" />
      </div>
    );
  }

  const visible = activity.slice(0, VISIBLE_EVENTS);
  const earlier = activity.slice(VISIBLE_EVENTS);

  return (
    <div>
      <Events entries={visible} isLastGroup={earlier.length === 0} />
      {earlier.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-[13px] font-medium text-accent hover:underline [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">Show {earlier.length} earlier event{earlier.length === 1 ? '' : 's'}</span>
            <span className="hidden group-open:inline">Hide earlier events</span>
          </summary>
          <div className="mt-3">
            <Events entries={earlier} isLastGroup />
          </div>
        </details>
      )}
    </div>
  );
}
