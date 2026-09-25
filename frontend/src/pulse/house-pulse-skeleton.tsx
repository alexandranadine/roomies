import { Skeleton } from '../components/ui/index.js';

/** Compact placeholder matching House Pulse glance card. */
export function HousePulseSkeleton() {
  return (
    <div aria-busy="true" data-testid="house-pulse-loading">
      <Skeleton className="h-[4.25rem] w-full rounded-xl lg:h-32" announced />
    </div>
  );
}
