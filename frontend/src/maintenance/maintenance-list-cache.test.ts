import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { MaintenanceListPage } from './maintenance-api.js';
import {
  detailToListItem,
  seedMaintenanceListCachesAfterCreate,
  seedMaintenanceListCachesAfterResolve,
  type MaintenanceListInfiniteData,
} from './maintenance-list-cache.js';
import { maintenanceKeys } from './maintenance-query-keys.js';
import {
  detailFromListItem,
  FIXTURE_H,
  FIXTURE_R,
  listPage,
  TEST_HOME_A,
} from './test-fixtures.js';

function listData(
  pages: MaintenanceListPage[],
): MaintenanceListInfiniteData {
  return {
    pages,
    pageParams: pages.map((_page, index) =>
      index === 0 ? undefined : `cursor-${index}`,
    ),
  };
}

describe('maintenance list cache helpers', () => {
  it('detailToListItem strips details', () => {
    const detail = detailFromListItem(FIXTURE_H, 'Secret notes');
    expect(detailToListItem(detail)).toEqual(FIXTURE_H);
  });

  it('prepends create into ALL and OPEN caches only', () => {
    const queryClient = new QueryClient();
    const created = detailFromListItem(
      { ...FIXTURE_H, id: 'new-id', title: 'New item' },
      null,
    );
    queryClient.setQueryData(
      maintenanceKeys.list(TEST_HOME_A, {}),
      listData([listPage([FIXTURE_R])]),
    );
    queryClient.setQueryData(
      maintenanceKeys.list(TEST_HOME_A, { status: 'OPEN' }),
      listData([listPage([FIXTURE_H])]),
    );
    queryClient.setQueryData(
      maintenanceKeys.list(TEST_HOME_A, { status: 'RESOLVED' }),
      listData([listPage([FIXTURE_R])]),
    );

    seedMaintenanceListCachesAfterCreate(queryClient, TEST_HOME_A, created);

    const allList = queryClient.getQueryData<MaintenanceListInfiniteData>(
      maintenanceKeys.list(TEST_HOME_A, {}),
    );
    expect(allList?.pages[0]?.items[0]?.id).toBe('new-id');
    const openList = queryClient.getQueryData<MaintenanceListInfiniteData>(
      maintenanceKeys.list(TEST_HOME_A, { status: 'OPEN' }),
    );
    expect(openList?.pages[0]?.items[0]?.id).toBe('new-id');
    const resolvedList = queryClient.getQueryData<MaintenanceListInfiniteData>(
      maintenanceKeys.list(TEST_HOME_A, { status: 'RESOLVED' }),
    );
    expect(resolvedList?.pages[0]?.items.map((row) => row.id)).toEqual([
      FIXTURE_R.id,
    ]);
  });

  it('does not write create into other Home caches', () => {
    const queryClient = new QueryClient();
    const created = detailFromListItem(
      { ...FIXTURE_H, id: 'new-id', title: 'New item' },
      null,
    );
    queryClient.setQueryData(
      maintenanceKeys.list('other-home', {}),
      listData([listPage([])]),
    );

    seedMaintenanceListCachesAfterCreate(queryClient, TEST_HOME_A, created);

    const otherList = queryClient.getQueryData<MaintenanceListInfiniteData>(
      maintenanceKeys.list('other-home', {}),
    );
    expect(otherList?.pages[0]?.items).toEqual([]);
  });

  it('updates resolve across ALL, removes OPEN, prepends RESOLVED', () => {
    const queryClient = new QueryClient();
    const resolved = detailFromListItem(
      {
        ...FIXTURE_H,
        status: 'RESOLVED',
        resolvedAt: '2026-09-13T12:00:00.000Z',
        resolvedByMembershipId: FIXTURE_H.createdByMembershipId,
        updatedAt: '2026-09-13T12:00:00.000Z',
      },
      null,
    );
    queryClient.setQueryData(
      maintenanceKeys.list(TEST_HOME_A, {}),
      listData([listPage([FIXTURE_H, FIXTURE_R])]),
    );
    queryClient.setQueryData(
      maintenanceKeys.list(TEST_HOME_A, { status: 'OPEN' }),
      listData([listPage([FIXTURE_H])]),
    );
    queryClient.setQueryData(
      maintenanceKeys.list(TEST_HOME_A, { status: 'RESOLVED' }),
      listData([listPage([FIXTURE_R])]),
    );

    seedMaintenanceListCachesAfterResolve(queryClient, TEST_HOME_A, resolved);

    const allList = queryClient.getQueryData<MaintenanceListInfiniteData>(
      maintenanceKeys.list(TEST_HOME_A, {}),
    );
    const allItems = allList?.pages[0]?.items ?? [];
    expect(allItems.find((row) => row.id === FIXTURE_H.id)?.status).toBe(
      'RESOLVED',
    );

    const openList = queryClient.getQueryData<MaintenanceListInfiniteData>(
      maintenanceKeys.list(TEST_HOME_A, { status: 'OPEN' }),
    );
    const openItems = openList?.pages[0]?.items ?? [];
    expect(openItems.some((row) => row.id === FIXTURE_H.id)).toBe(false);

    const resolvedList = queryClient.getQueryData<MaintenanceListInfiniteData>(
      maintenanceKeys.list(TEST_HOME_A, { status: 'RESOLVED' }),
    );
    const resolvedItems = resolvedList?.pages[0]?.items ?? [];
    expect(resolvedItems[0]?.id).toBe(FIXTURE_H.id);
    expect(resolvedItems[0]?.status).toBe('RESOLVED');
  });
});
