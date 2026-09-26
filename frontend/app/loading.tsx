import { Skeleton } from '@/components/ui/skeleton';

export default function Loading() {
  return (
    <main aria-busy="true" aria-label="Loading" className="mx-auto w-full max-w-md px-6 pt-[18vh]">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="mt-2 h-4 w-32" />
      <Skeleton className="mt-6 h-40 w-full rounded-xl" />
    </main>
  );
}
