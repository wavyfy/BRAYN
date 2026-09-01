import { type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function ErrorText({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p role="alert" className={cn('text-sm text-red-600', className)} {...props} />;
}
