import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

export const buttonVariantClasses = {
  primary: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary/85',
  secondary: 'border border-border bg-surface text-foreground shadow-panel hover:border-border-strong hover:bg-subtle',
  ghost: 'text-muted-foreground hover:bg-subtle hover:text-foreground',
  danger: 'border border-danger/25 bg-surface text-danger hover:bg-danger/5',
} as const;

export const buttonSizeClasses = {
  default: 'h-8 gap-1.5 px-3 text-[13px]',
  sm: 'h-7 gap-1 px-2.5 text-xs',
} as const;

export type ButtonVariant = keyof typeof buttonVariantClasses;
export type ButtonSize = keyof typeof buttonSizeClasses;

/** Shared class builder so non-`<button>` elements (e.g. a `<Link>` styled as a button) can match exactly. */
export function buttonClassName(variant: ButtonVariant = 'primary', size: ButtonSize = 'default', className?: string) {
  return cn(
    'inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg font-medium transition-colors duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/60 focus-visible:ring-offset-1',
    'disabled:pointer-events-none disabled:opacity-50',
    buttonVariantClasses[variant],
    buttonSizeClasses[size],
    className,
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'default', ...props }, ref) => (
    <button ref={ref} className={buttonClassName(variant, size, className)} {...props} />
  ),
);
Button.displayName = 'Button';
