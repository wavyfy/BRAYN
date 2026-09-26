import { type TextareaHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'rounded-lg border border-border bg-surface text-sm text-foreground transition-colors',
        'placeholder:text-muted-foreground/70 hover:border-border-strong',
        'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'w-full px-3 py-2',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';
