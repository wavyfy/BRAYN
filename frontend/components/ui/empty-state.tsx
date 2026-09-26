import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** An honest "nothing here yet" — what's missing, and the one action that fixes it. Never fabricated content. */
export function EmptyState({ title, message, action, className }: { title?: string; message: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-2 px-6 py-12 text-center', className)}>
      {title && <p className="text-sm font-medium text-foreground">{title}</p>}
      <p className="max-w-sm text-[13px] text-muted-foreground">{message}</p>
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
