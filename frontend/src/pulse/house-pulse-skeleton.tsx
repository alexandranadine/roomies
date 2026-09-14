import { Skeleton } from '../components/ui/index.js';

/** Compact three-row placeholder matching House Pulse layout. */
export function HousePulseSkeleton() {
  return (
    <div
      className="flex flex-col gap-2"
      aria-busy="true"
      data-testid="house-pulse-loading"
    >
      <Skeleton className="h-6 w-36" announced />
      <Skeleton className="h-4 w-48" />
      <div className="overflow-hidden rounded-xl border border-border">
        <Skeleton className="h-16 w-full rounded-none" />
        <Skeleton className="h-16 w-full rounded-none border-t border-border" />
        <Skeleton className="h-16 w-full rounded-none border-t border-border" />
      </div>
    </div>
  );
}
