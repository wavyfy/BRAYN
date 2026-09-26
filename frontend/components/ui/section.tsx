import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A titled region on the page canvas: quiet 14px title, optional count/description, one action on the right. */
export function SectionHeader({
  title,
  count,
  description,
  action,
  className,
  as: Heading = 'h2',
}: {
  title: string;
  count?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  as?: 'h2' | 'h3';
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-x-3 gap-y-2', className)}>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <Heading className="text-sm font-semibold text-foreground">{title}</Heading>
          {count !== undefined && <span className="text-[13px] tabular-nums text-muted-foreground">{count}</span>}
        </div>
        {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}
