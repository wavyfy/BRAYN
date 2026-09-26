import { Skeleton } from '@/components/ui/skeleton';

/** Mirrors page.tsx: identity + metric strip, then opportunities / Ask BRAYN beside the risk + activity rail. */
export default function Loading() {
  return (
    <main aria-busy="true" aria-label="Loading customer">
      <div className="border-b border-border bg-surface px-6 py-5 lg:px-8">
        <div className="flex items-center gap-3.5">
          <Skeleton className="h-11 w-11 rounded-full" />
          <div>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="mt-2 h-3.5 w-64" />
          </div>
        </div>
        <Skeleton className="mt-5 h-[74px] w-full rounded-xl" />
      </div>

      <div className="grid grid-cols-1 items-start gap-8 px-6 py-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-8 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-3">
          <Skeleton className="h-4 w-44" />
          {[0, 1, 2].map((row) => (
            <div key={row} className="space-y-2 rounded-xl border border-border bg-surface shadow-panel p-4">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
        <div className="space-y-3">
          <Skeleton className="h-4 w-36" />
          <div className="space-y-3 rounded-xl border border-border bg-surface shadow-panel p-4">
            <Skeleton className="h-[72px] w-[72px] rounded-full" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-3/4" />
          </div>
        </div>
      </div>
    </main>
  );
}
