import { cn } from '@/lib/utils';

function initials(name: string): string {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/** Initials avatar — neutral by design: BRAYN has no customer photos, and color would imply a status it doesn't have. */
export function Avatar({ name, size = 'md', className }: { name: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const sizeClass = { sm: 'h-6 w-6 text-[10px]', md: 'h-8 w-8 text-xs', lg: 'h-11 w-11 text-sm' }[size];
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-subtle font-semibold text-foreground/70 ring-1 ring-inset ring-border', sizeClass, className)}
    >
      {initials(name)}
    </span>
  );
}
