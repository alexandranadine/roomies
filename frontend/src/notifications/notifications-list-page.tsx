import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button, EmptyState, Skeleton } from '../components/ui/index.js';
import { clearPrivateHomeQueryState } from '../homes/clear-private-home-queries.js';
import { currentUserQueryKey } from '../homes/home-query-keys.js';
import { ApiError } from '../platform/api/index.js';
import { NotificationRow } from './notification-row.js';
import { useNotificationsList } from './use-notifications-list.js';
import { useReadAllNotifications } from './use-read-all-notifications.js';

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function isTransientListError(error: unknown): boolean {
  return !(
    error instanceof ApiError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

export function NotificationsListPage() {
  const queryClient = useQueryClient();
  const listQuery = useNotificationsList();
  const readAllMutation = useReadAllNotifications();

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

  const hasLoadedUnread = items.some((item) => item.readAt === null);
  const showLoading = listQuery.isPending && listQuery.data === undefined;
  const showEmpty =
    listQuery.isSuccess && items.length === 0 && !listQuery.isFetching;
  const lastPage =
    listQuery.data?.pages[listQuery.data.pages.length - 1] ?? undefined;
  const canLoadMore =
    lastPage?.hasMore === true && lastPage.nextCursor !== null;
  const showLoadMore = canLoadMore && !listQuery.isFetchNextPageError;

  return (
    <DocumentTitle title="Notifications · Roomies">
      <div
        data-testid="notifications-page"
        className="mx-auto flex w-full max-w-[860px] flex-col gap-4"
      >
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
              Notifications
            </h1>
            <p className="max-w-prose text-sm text-text-secondary">
              Updates that matter to you across your Homes.
            </p>
          </div>
          {hasLoadedUnread ? (
            <Button
              type="button"
              variant="secondary"
              className="shrink-0 self-start"
              loading={readAllMutation.isPending}
              disabled={readAllMutation.isPending}
              onClick={() => {
                if (readAllMutation.isPending) {
                  return;
                }
                void readAllMutation.mutateAsync();
              }}
            >
              Mark all as read
            </Button>
          ) : null}
        </header>

        {readAllMutation.isError ? (
          <Alert variant="danger" title="Couldn’t mark notifications as read">
            <p className="mb-3">Something went wrong. Try again.</p>
            <Button
              type="button"
              variant="secondary"
              loading={readAllMutation.isPending}
              onClick={() => {
                void readAllMutation.mutateAsync();
              }}
            >
              Retry
            </Button>
          </Alert>
        ) : null}

        {showLoading ? (
          <div className="flex flex-col gap-1.5 lg:gap-2" aria-busy="true">
            <Skeleton className="h-14 w-full rounded-xl" announced />
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        ) : null}

        {listQuery.isError &&
        !listQuery.isFetchNextPageError &&
        isTransientListError(listQuery.error) ? (
          <Alert variant="danger" title="Couldn’t load notifications">
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
            className="px-4 py-6"
            title="You're all caught up."
            description="Household updates will show up here."
          />
        ) : null}

        {items.length > 0 ? (
          <ul
            aria-label="Notifications"
            className="m-0 flex list-none flex-col gap-1.5 p-0 lg:gap-2"
          >
            {items.map((item) => (
              <NotificationRow key={item.id} item={item} />
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
          <Alert variant="danger" title="Couldn’t load more notifications">
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
