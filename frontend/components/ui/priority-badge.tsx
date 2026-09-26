import { cn } from '@/lib/utils';
import { StatusBadge, type BadgeTone } from './status-badge';

/** Revenue opportunity priority — doc10 Revenue Opportunity Detector priority levels. */
export type Priority = 'critical' | 'high' | 'medium' | 'low';

const priorityTone: Record<Priority, BadgeTone> = {
  critical: 'danger',
  high: 'warning',
  medium: 'info',
  low: 'neutral',
};

export function PriorityBadge({ priority, className }: { priority: Priority; className?: string }) {
  return (
    <StatusBadge tone={priorityTone[priority]} className={cn('capitalize', className)}>
      {priority}
    </StatusBadge>
  );
}
