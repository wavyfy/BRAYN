import { type InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'rounded-lg border border-border bg-surface text-sm text-foreground transition-colors',
        'placeholder:text-muted-foreground/70 hover:border-border-strong',
        'focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'h-8 w-full px-2.5',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
