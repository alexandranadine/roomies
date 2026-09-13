import { useOutletContext, useParams, useSearchParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button, EmptyState, Skeleton } from '../components/ui/index.js';
import type { HomeShellOutletContext } from '../homes/home-overview-page.js';
import { ApiError } from '../platform/api/index.js';
import type { MaintenanceStatus } from './maintenance-api.js';
import { MaintenanceListItemRow } from './maintenance-list-item-row.js';
import { useMaintenanceList } from './use-maintenance-list.js';

export type MaintenanceStatusFilter = 'ALL' | MaintenanceStatus;

function parseStatusFilter(value: string | null): MaintenanceStatusFilter {
  if (value === 'OPEN' || value === 'RESOLVED') {
    return value;
  }
  return 'ALL';
}

function emptyCopy(filter: MaintenanceStatusFilter): string {
  switch (filter) {
    case 'OPEN':
      return 'No open maintenance.';
    case 'RESOLVED':
      return 'No resolved maintenance.';
    case 'ALL':
      return 'No maintenance items yet.';
  }
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

export function MaintenanceListPage() {
  const { home } = useOutletContext<HomeShellOutletContext>();
  const { homeId: routeHomeId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = parseStatusFilter(searchParams.get('status'));
  const status = filter === 'ALL' ? undefined : filter;

  // URL homeId is authoritative; never render another Home's keyed data here.
  const homeId = home.id === routeHomeId ? home.id : '';

  const listQuery = useMaintenanceList({
    homeId,
    status,
    enabled: homeId.length > 0,
  });

  const items =
    listQuery.data === undefined
      ? []
      : listQuery.data.pages.flatMap((page) => page.items);

  const setFilter = (next: MaintenanceStatusFilter) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'ALL') {
      params.delete('status');
    } else {
      params.set('status', next);
    }
    setSearchParams(params, { replace: true });
  };

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
  const canLoadMore = lastPage?.hasMore === true;

  return (
    <DocumentTitle title={`Maintenance · ${home.name} · Roomies`}>
      <div className="flex flex-col gap-5">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
            Maintenance
          </h1>
          <p className="max-w-prose text-sm text-text-secondary">
            Household upkeep that needs attention — calm, useful, and shared
            only when it should be.
          </p>
        </header>

        <div
          role="group"
          aria-label="Filter by status"
          className="flex flex-wrap gap-2"
        >
          {(
            [
              ['ALL', 'All'],
              ['OPEN', 'Open'],
              ['RESOLVED', 'Resolved'],
            ] as const
          ).map(([value, label]) => {
            const selected = filter === value;
            return (
              <Button
                key={value}
                type="button"
                variant={selected ? 'secondary' : 'subtle'}
                aria-pressed={selected}
                onClick={() => {
                  setFilter(value);
                }}
              >
                {label}
              </Button>
            );
          })}
        </div>

        {showLoading ? (
          <div className="flex flex-col gap-3" aria-busy="true">
            <Skeleton className="h-20 w-full" announced />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : null}

        {listQuery.isError && isTransientListError(listQuery.error) ? (
          <Alert variant="danger" title="Couldn’t load maintenance">
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

        {showEmpty ? <EmptyState title={emptyCopy(filter)} /> : null}

        {items.length > 0 ? (
          <ul className="flex list-none flex-col gap-3 p-0">
            {items.map((item) => (
              <MaintenanceListItemRow
                key={item.id}
                homeId={homeId}
                item={item}
              />
            ))}
          </ul>
        ) : null}

        {canLoadMore ? (
          <div>
            <Button
              type="button"
              variant="secondary"
              loading={listQuery.isFetchingNextPage}
              onClick={() => {
                void listQuery.fetchNextPage();
              }}
            >
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    </DocumentTitle>
  );
}
