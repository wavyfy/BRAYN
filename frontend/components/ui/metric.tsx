import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** One figure in a MetricStrip: small label, large tabular value, optional one-line context. */
export function Metric({ label, value, hint, className }: { label: string; value: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 px-4 py-3', className)}>
      <dt className="truncate text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-xl font-semibold tracking-tight tabular-nums text-foreground">{value}</dd>
      {hint && <dd className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

/** A single hairline-divided row of metrics — one surface instead of one card per number. */
export function MetricStrip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl
      className={cn(
        'grid grid-cols-2 overflow-hidden rounded-xl border border-border bg-surface shadow-panel sm:grid-cols-3 lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none',
        '[&>*]:border-border max-lg:[&>*]:border-b lg:[&>*:not(:first-child)]:border-l',
        className,
      )}
    >
      {children}
    </dl>
  );
}
