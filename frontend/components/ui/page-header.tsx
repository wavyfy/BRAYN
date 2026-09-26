import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The top bar of every page on the canvas: title, one line of context, and
 * page-level actions. The workspace shell owns navigation, so a back-link is
 * only for genuinely nested pages (e.g. an automation's detail).
 */
export function PageHeader({
  title,
  backHref,
  backLabel,
  description,
  actions,
}: {
  title: string;
  backHref?: string;
  backLabel?: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="border-b border-border bg-surface px-6 py-4 lg:px-8">
      {backHref && (
        <Link href={backHref} className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          &larr; {backLabel}
        </Link>
      )}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">{title}</h1>
          {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** Standard padded content region under a PageHeader. */
export function PageBody({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`px-6 py-6 lg:px-8 ${className}`}>{children}</div>;
}
