import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import type {
  MaintenanceDetail,
  MaintenanceListItem,
  MaintenanceListPage,
} from './maintenance-api.js';
import type { MaintenanceListFilter } from './maintenance-query-keys.js';
import { maintenanceKeys } from './maintenance-query-keys.js';

export type MaintenanceListInfiniteData = InfiniteData<
  MaintenanceListPage,
  string | undefined
>;

/** Strip detail-only fields for list cache writes. */
export function detailToListItem(detail: MaintenanceDetail): MaintenanceListItem {
  const { details: _details, ...item } = detail;
  return item;
}

function parseListFilter(queryKey: QueryKey): MaintenanceListFilter {
  const filters = queryKey[4];
  if (filters !== undefined && typeof filters === 'object' && filters !== null) {
    const status = (filters as MaintenanceListFilter).status;
    if (status === 'OPEN' || status === 'RESOLVED') {
      return { status };
    }
  }
  return {};
}

function itemMatchesFilter(
  item: MaintenanceListItem,
  filter: MaintenanceListFilter,
): boolean {
  if (filter.status === undefined) {
    return true;
  }
  return item.status === filter.status;
}

function emptyListPage(item: MaintenanceListItem): MaintenanceListPage {
  return { items: [item], hasMore: false, nextCursor: null };
}

function prependItem(
  data: MaintenanceListInfiniteData | undefined,
  item: MaintenanceListItem,
): MaintenanceListInfiniteData {
  if (data === undefined) {
    return {
      pages: [emptyListPage(item)],
      pageParams: [undefined],
    };
  }
  const firstPage = data.pages[0];
  if (firstPage === undefined) {
    return {
      pages: [emptyListPage(item)],
      pageParams: data.pageParams.length > 0 ? data.pageParams : [undefined],
    };
  }
  if (firstPage.items.some((row) => row.id === item.id)) {
    return data;
  }
  return {
    ...data,
    pages: [{ ...firstPage, items: [item, ...firstPage.items] }, ...data.pages.slice(1)],
  };
}

function replaceItem(
  data: MaintenanceListInfiniteData,
  item: MaintenanceListItem,
): MaintenanceListInfiniteData {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((row) => (row.id === item.id ? item : row)),
    })),
  };
}

function removeItem(
  data: MaintenanceListInfiniteData,
  maintenanceEntryId: string,
): MaintenanceListInfiniteData {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.filter((row) => row.id !== maintenanceEntryId),
    })),
  };
}

function updateMatchingListCaches(
  queryClient: QueryClient,
  homeId: string,
  updater: (
    old: MaintenanceListInfiniteData | undefined,
    filter: MaintenanceListFilter,
  ) => MaintenanceListInfiniteData | undefined,
): void {
  for (const [queryKey, data] of queryClient.getQueriesData<MaintenanceListInfiniteData>(
    { queryKey: [...maintenanceKeys.all(homeId), 'list'] },
  )) {
    const filter = parseListFilter(queryKey);
    const next = updater(data, filter);
    if (next !== undefined && next !== data) {
      queryClient.setQueryData(queryKey, next);
    }
  }
}

/**
 * Writes authoritative create response into same-Home list caches that match
 * the item status filter. Background invalidation still reconciles pagination.
 */
export function seedMaintenanceListCachesAfterCreate(
  queryClient: QueryClient,
  homeId: string,
  created: MaintenanceDetail,
): void {
  const item = detailToListItem(created);
  updateMatchingListCaches(queryClient, homeId, (old, filter) => {
    if (!itemMatchesFilter(item, filter)) {
      return old;
    }
    return prependItem(old, item);
  });
}

/**
 * Writes authoritative resolve response into same-Home list caches.
 * OPEN-filtered lists drop the row; ALL/RESOLVED lists reflect resolved state.
 */
export function seedMaintenanceListCachesAfterResolve(
  queryClient: QueryClient,
  homeId: string,
  resolved: MaintenanceDetail,
): void {
  const item = detailToListItem(resolved);
  updateMatchingListCaches(queryClient, homeId, (old, filter) => {
    if (filter.status === 'OPEN') {
      return old === undefined ? old : removeItem(old, item.id);
    }
    if (filter.status === 'RESOLVED') {
      if (old === undefined) {
        return prependItem(undefined, item);
      }
      const exists = old.pages.some((page) =>
        page.items.some((row) => row.id === item.id),
      );
      return exists ? replaceItem(old, item) : prependItem(old, item);
    }
    return old === undefined ? old : replaceItem(old, item);
  });
}
