import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-foreground/[0.07]', className)} {...props} />;
}

/** Generic route-level loading state: header bar + a metric row + a table — matches the shape of most workspace pages. */
export function PageSkeleton() {
  return (
    <main aria-busy="true" aria-label="Loading">
      <div className="border-b border-border bg-surface px-6 py-5 lg:px-8">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="mt-2 h-3.5 w-72" />
      </div>
      <div className="space-y-6 px-6 py-6 lg:px-8">
        <Skeleton className="h-[74px] w-full rounded-xl" />
        <div className="space-y-2.5">
          {[0, 1, 2, 3, 4].map((row) => (
            <Skeleton key={row} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </main>
  );
}
