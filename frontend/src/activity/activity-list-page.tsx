import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useOutletContext, useParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button, EmptyState, Skeleton } from '../components/ui/index.js';
import { clearPrivateHomeQueryState } from '../homes/clear-private-home-queries.js';
import type { HomeShellOutletContext } from '../homes/home-overview-page.js';
import { currentUserQueryKey } from '../homes/home-query-keys.js';
import { ApiError } from '../platform/api/index.js';
import { ActivityEventRow } from './activity-event-row.js';
import { useActivityList } from './use-activity-list.js';

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function isConcealedScope(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.code === 'NOT_FOUND')
  );
}

function isTransientListError(error: unknown): boolean {
  return !(
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

export function ActivityListPage() {
  const { home } = useOutletContext<HomeShellOutletContext>();
  const { homeId: routeHomeId = '' } = useParams();
  const queryClient = useQueryClient();

  // URL homeId is authoritative; never render another Home's keyed data here.
  const homeId = home.id === routeHomeId ? home.id : '';

  const listQuery = useActivityList({
    homeId,
    enabled: homeId.length > 0,
  });

  useEffect(() => {
    if (isUnauthenticated(listQuery.error)) {
      clearPrivateHomeQueryState(queryClient);
      void queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
    }
  }, [listQuery.error, queryClient]);

  const items =
    listQuery.data === undefined
      ? []
      : listQuery.data.pages.flatMap((page) => page.items);

  if (listQuery.isError && isConcealedScope(listQuery.error)) {
    return (
      <DocumentTitle title="Home unavailable · Roomies">
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            This Home isn’t available
          </h1>
          <p className="max-w-prose text-base text-text-secondary">
            It may not exist, or you may not be able to open it right now.
          </p>
        </div>
      </DocumentTitle>
    );
  }

  const showLoading = listQuery.isPending && listQuery.data === undefined;
  const showEmpty =
    listQuery.isSuccess && items.length === 0 && !listQuery.isFetching;
  const lastPage =
    listQuery.data?.pages[listQuery.data.pages.length - 1] ?? undefined;
  const canLoadMore =
    lastPage?.hasMore === true && lastPage.nextCursor !== null;
  const showLoadMore = canLoadMore && !listQuery.isFetchNextPageError;

  return (
    <DocumentTitle title={`Activity · ${home.name} · Roomies`}>
      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            Activity
          </h1>
          <p className="max-w-prose text-sm text-text-secondary">
            Recent things happening around the home.
          </p>
        </header>

        {showLoading ? (
          <div
            className="flex flex-col overflow-hidden rounded-xl border border-border"
            aria-busy="true"
          >
            <Skeleton className="h-16 w-full rounded-none" announced />
            <Skeleton className="h-16 w-full rounded-none border-t border-border" />
            <Skeleton className="h-16 w-full rounded-none border-t border-border" />
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
            className="m-0 list-none divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface p-0"
          >
            {items.map((item) => (
              <ActivityEventRow key={item.id} item={item} />
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
      </div>
    </DocumentTitle>
  );
}
