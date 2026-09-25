import { Skeleton } from '../components/ui/index.js';

/** Compact placeholder matching House Pulse layout. */
export function HousePulseSkeleton() {
  return (
    <div
      className="flex flex-col gap-2"
      aria-busy="true"
      data-testid="house-pulse-loading"
    >
      <Skeleton className="h-5 w-28" announced />
      <div className="overflow-hidden rounded-xl border border-border">
        <Skeleton className="h-16 w-full rounded-none" />
      </div>
    </div>
  );
}