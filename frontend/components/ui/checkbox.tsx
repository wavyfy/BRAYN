import { type InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      className={cn(
        'h-4 w-4 rounded border-slate-300 text-slate-900',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Checkbox.displayName = 'Checkbox';
