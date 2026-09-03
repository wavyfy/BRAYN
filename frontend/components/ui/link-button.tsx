import Link, { type LinkProps } from 'next/link';
import { type AnchorHTMLAttributes } from 'react';
import { buttonClassName, type ButtonSize, type ButtonVariant } from './button';

type LinkButtonProps = LinkProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
  };

/** A navigation action styled like Button — for "go back / go here" links, not form submission. */
export function LinkButton({ className, variant = 'primary', size = 'default', ...props }: LinkButtonProps) {
  return <Link className={buttonClassName(variant, size, className)} {...props} />;
}
