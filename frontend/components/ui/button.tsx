import { type ButtonHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

export const buttonVariantClasses = {
  primary: 'bg-slate-900 text-white hover:bg-slate-800 focus-visible:ring-slate-900',
  secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus-visible:ring-slate-400',
  danger: 'border border-red-200 bg-white text-red-600 hover:bg-red-50 focus-visible:ring-red-500',
} as const;

export const buttonSizeClasses = {
  default: 'h-9 px-4 text-sm',
  sm: 'h-8 px-3 text-xs',
} as const;

export type ButtonVariant = keyof typeof buttonVariantClasses;
export type ButtonSize = keyof typeof buttonSizeClasses;

/** Shared class builder so non-`<button>` elements (e.g. a `<Link>` styled as a button) can match exactly. */
export function buttonClassName(variant: ButtonVariant = 'primary', size: ButtonSize = 'default', className?: string) {
  return cn(
    'inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
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
