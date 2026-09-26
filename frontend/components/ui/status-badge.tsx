import { cn } from '@/lib/utils';

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const toneClasses: Record<BadgeTone, string> = {
  neutral: 'bg-subtle text-foreground/70 ring-border',
  success: 'bg-success/[0.08] text-success ring-success/15',
  warning: 'bg-warning/[0.08] text-warning ring-warning/15',
  danger: 'bg-danger/[0.07] text-danger ring-danger/15',
  info: 'bg-info/[0.08] text-info ring-info/15',
  accent: 'bg-accent/[0.08] text-accent ring-accent/15',
};

const dotClasses: Record<BadgeTone, string> = {
  neutral: 'bg-muted-foreground/60',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  info: 'bg-info',
  accent: 'bg-accent',
};

/** Shared badge shape — every status/priority/role badge in the app builds on this. */
export const badgeShapeClassName = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11.5px] font-medium leading-4 ring-1 ring-inset';

export function StatusBadge({ tone, dot, className, children }: { tone: BadgeTone; dot?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn(badgeShapeClassName, toneClasses[tone], className)}>
      {dot && <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', dotClasses[tone])} />}
      {children}
    </span>
  );
}

/** A bare status dot + label, for dense rows where a filled badge would be too loud. */
export function StatusDot({ tone, className, children }: { tone: BadgeTone; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium text-foreground/80', className)}>
      <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClasses[tone])} />
      {children}
    </span>
  );
}
