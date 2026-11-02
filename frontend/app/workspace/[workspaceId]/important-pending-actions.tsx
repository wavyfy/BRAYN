import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { SectionHeader } from '@/components/ui/section';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorText } from '@/components/ui/alert';
import { PriorityBadge, type Priority } from '@/components/ui/priority-badge';
import { formatDateTime, formatRelative } from '@/lib/format';
import { opportunityTypeLabel } from './customers/[canonicalCustomerId]/revenue-opportunities';

export type InternalNotification = {
  id: string;
  createdAt: string;
  opportunityId: string;
  canonicalCustomerId: string;
  type: string;
  priority: Priority;
  reason: string;
};

export type NotificationsPage = { items: InternalNotification[]; total: number };

/**
 * Dashboard → Important pending actions (doc24; decision Nov 2, 2026): the newest internal notifications created by
 * automation, plus the total. `notifications` is null when the request failed — the rest of the dashboard still renders.
 */
export function ImportantPendingActions({ workspaceId, notifications }: { workspaceId: string; notifications: NotificationsPage | null }) {
  return (
    <Card className="p-5">
      <SectionHeader
        title="Important pending actions"
        description="Opportunities your automations flagged for attention."
        count={notifications && notifications.total > 0 ? `${notifications.total} total` : undefined}
      />
      {notifications === null ? (
        <div className="mt-4">
          <ErrorText>Could not load notifications. Refresh the page to try again.</ErrorText>
        </div>
      ) : notifications.items.length === 0 ? (
        <EmptyState
          title="Nothing flagged yet"
          message="Create an automation with the “Create internal notification” action to see opportunities here."
          className="py-8"
        />
      ) : (
        <ul className="mt-3 divide-y divide-border">
          {notifications.items.map((notification) => (
            <li key={notification.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-foreground">{opportunityTypeLabel(notification.type)}</span>
                  <PriorityBadge priority={notification.priority} />
                </div>
                <p className="text-[13px] text-foreground/80">{notification.reason}</p>
                <p className="text-xs text-muted-foreground" title={formatDateTime(notification.createdAt)}>
                  {formatRelative(notification.createdAt)}
                </p>
              </div>
              <Link
                href={`/workspace/${workspaceId}/customers/${notification.canonicalCustomerId}`}
                className="shrink-0 text-[13px] font-medium text-accent hover:underline"
              >
                View customer
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
