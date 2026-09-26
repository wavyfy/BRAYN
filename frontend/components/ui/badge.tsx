import { cn } from '@/lib/utils';
import { badgeShapeClassName } from './status-badge';

/** Doc 28 role catalog. Neutral for every role — a role is identity, not status, so it never borrows semantic color. */
export function RoleBadge({ role, className }: { role: string; className?: string }) {
  return <span className={cn(badgeShapeClassName, 'bg-subtle capitalize text-foreground/70 ring-border', className)}>{role}</span>;
}
