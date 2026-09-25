import { Skeleton } from '../components/ui/index.js';

/** Compact placeholder matching House Pulse glance / desktop bar. */
export function HousePulseSkeleton() {
  return (
    <div aria-busy="true" data-testid="house-pulse-loading">
      <Skeleton className="h-[4.25rem] w-full rounded-xl lg:h-11" announced />
    </div>
  );
}
