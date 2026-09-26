import { PlusIcon } from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';
import { useOutletContext, useParams, useSearchParams } from 'react-router';
import { DocumentTitle } from '../components/document-title.js';
import { Alert, Button, EmptyState, Skeleton } from '../components/ui/index.js';
import { cn } from '../components/ui/cn.js';
import type { HomeShellOutletContext } from '../homes/home-overview-page.js';
import { ApiError } from '../platform/api/index.js';
import { CreateMaintenanceDialog } from './create-maintenance-dialog.js';
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

function emptyCopy(filter: MaintenanceStatusFilter): {
  title: string;
  description?: string;
} {
  switch (filter) {
    case 'OPEN':
      return { title: 'Nothing needs attention right now.' };
    case 'RESOLVED':
      return { title: 'No resolved items yet.' };
    case 'ALL':
      return {
        title: 'Nothing needs attention right now.',
        description: 'Household maintenance items will show up here.',
      };
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
  const [createOpen, setCreateOpen] = useState(false);
  const filter = parseStatusFilter(searchParams.get('status'));
  const status = filter === 'ALL' ? undefined : filter;

  // URL homeId is authoritative; never render another Home's keyed data here.
  const homeId = home.id === routeHomeId ? home.id : '';

  // Create draft stays bound to the Home where it opened — close on Home switch.
  useEffect(() => {
    setCreateOpen(false);
  }, [homeId]);

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
  const empty = emptyCopy(filter);

  return (
    <DocumentTitle title={`Maintenance · ${home.name} · Roomies`}>
      <div
        data-testid="maintenance-page"
        className="mx-auto flex w-full max-w-[980px] flex-col gap-5"
      >
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
              Maintenance
            </h1>
            <p className="max-w-prose text-sm text-text-secondary">
              Household upkeep that needs attention.
            </p>
          </div>
          <Button
            type="button"
            className="shrink-0 self-start"
            icon={<PlusIcon className="size-4" aria-hidden="true" />}
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            Add maintenance
          </Button>
        </header>

        <CreateMaintenanceDialog
          homeId={homeId}
          open={createOpen}
          onOpenChange={setCreateOpen}
        />

        <div
          role="group"
          aria-label="Filter by status"
          className="inline-flex w-full max-w-full flex-wrap gap-0.5 rounded-xl border border-border bg-surface p-0.5 sm:w-auto sm:self-start"
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
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                className={cn(
                  'min-h-9 flex-1 rounded-lg px-3 text-sm font-semibold sm:flex-none',
                  'outline-none transition-colors',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                  selected
                    ? 'bg-subtle text-text-primary'
                    : 'text-text-secondary hover:bg-subtle hover:text-text-primary',
                )}
                onClick={() => {
                  setFilter(value);
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {showLoading ? (
          <div className="flex flex-col gap-1.5 lg:gap-2" aria-busy="true">
            <Skeleton className="h-16 w-full rounded-xl" announced />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
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

        {showEmpty ? (
          <EmptyState
            className="px-4 py-6"
            title={empty.title}
            description={empty.description}
          />
        ) : null}

        {items.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 lg:gap-2">
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
