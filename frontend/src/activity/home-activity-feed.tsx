import { Link } from 'react-router';
import { Alert, Button, EmptyState, Skeleton } from '../components/ui/index.js';
import { ApiError } from '../platform/api/index.js';
import { ActivityFeedCard } from './activity-feed-card.js';
import { useActivityList } from './use-activity-list.js';

export type HomeActivityFeedProps = {
  homeId: string;
};

function isTransientListError(error: unknown): boolean {
  return !(
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

/**
 * Home-screen activity feed. Shares the existing Activity query key/cache.
 */
export function HomeActivityFeed({ homeId }: HomeActivityFeedProps) {
  const listQuery = useActivityList({
    homeId,
    enabled: homeId.length > 0,
  });

  const items =
    listQuery.data === undefined
      ? []
      : listQuery.data.pages.flatMap((page) => page.items);

  const showLoading = listQuery.isPending && listQuery.data === undefined;
  const showEmpty =
    listQuery.isSuccess && items.length === 0 && !listQuery.isFetching;
  const lastPage =
    listQuery.data?.pages[listQuery.data.pages.length - 1] ?? undefined;
  const canLoadMore =
    lastPage?.hasMore === true && lastPage.nextCursor !== null;
  const showLoadMore = canLoadMore && !listQuery.isFetchNextPageError;
  const activityHref = `/homes/${encodeURIComponent(homeId)}/activity`;

  return (
    <section
      aria-labelledby="home-activity-heading"
      className="flex flex-col gap-2"
    >
      <header className="flex items-baseline justify-between gap-3">
        <h2
          id="home-activity-heading"
          className="text-base font-semibold tracking-tight text-text-primary"
        >
          Activity
        </h2>
        <Link
          to={activityHref}
          aria-label="Activity"
          className="text-sm font-medium text-brand underline-offset-4 hover:text-brand-hover hover:underline focus-visible:rounded-sm"
        >
          See all
        </Link>
      </header>

      {showLoading ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-14 w-full rounded-xl" announced />
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
      ) : null}

      {listQuery.isError &&
      !listQuery.isFetchNextPageError &&
      isTransientListError(listQuery.error) ? (
        <Alert variant="danger" title="Couldn’t load activity">
          <p className="mb-3">Something went wrong. Try again.</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              void listQuery.refetch();
            }}
          >
            Retry
          </Button>
        </Alert>
      ) : null}

      {showEmpty ? (
        <EmptyState
          title="No activity yet"
          description="Updates from your home will show up here."
        />
      ) : null}

      {items.length > 0 ? (
        <ul
          aria-label="Home activity"
          className="m-0 flex list-none flex-col gap-1.5 p-0 lg:gap-2"
        >
          {items.map((item) => (
            <ActivityFeedCard key={item.id} item={item} />
          ))}
        </ul>
      ) : null}

      {showLoadMore ? (
        <div>
          <Button
            type="button"
            variant="secondary"
            loading={listQuery.isFetchingNextPage}
            onClick={() => {
              if (listQuery.isFetchingNextPage) {
                return;
              }
              void listQuery.fetchNextPage();
            }}
          >
            Load more
          </Button>
        </div>
      ) : null}

      {listQuery.isFetchNextPageError ? (
        <Alert variant="danger" title="Couldn’t load more activity">
          <p className="mb-3">Something went wrong. Try again.</p>
          <Button
            type="button"
            variant="secondary"
            loading={listQuery.isFetchingNextPage}
            onClick={() => {
              void listQuery.fetchNextPage();
            }}
          >
            Retry
          </Button>
        </Alert>
      ) : null}
    </section>
  );
}
