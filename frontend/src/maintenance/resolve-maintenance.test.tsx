import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { pulseKeys } from '../pulse/pulse-query-keys.js';
import { clearHousePulse } from '../pulse/test-fixtures.js';
import { renderApp } from '../test/render.js';
import { maintenanceKeys } from './maintenance-query-keys.js';
import {
  detailFromListItem,
  FIXTURE_A,
  FIXTURE_H,
  FIXTURE_R,
  listPage,
  notFoundBody,
  TEST_HOME_A,
  TEST_HOME_B,
} from './test-fixtures.js';
import { detailCacheKey, stubMaintenanceApis } from './test-stub.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Maintenance resolve UI', () => {
  it('shows Mark resolved on OPEN detail and hides it on RESOLVED', async () => {
    stubMaintenanceApis({
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_H.id)]: detailFromListItem(
          FIXTURE_H,
          null,
        ),
        [detailCacheKey(TEST_HOME_A, FIXTURE_R.id)]: detailFromListItem(
          FIXTURE_R,
          null,
        ),
      },
    });
    const { router } = renderApp(
      `/homes/${TEST_HOME_A}/maintenance/${FIXTURE_H.id}`,
    );
    expect(
      await screen.findByRole('button', { name: 'Mark resolved' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/reopen/i)).not.toBeInTheDocument();

    await router.navigate(`/homes/${TEST_HOME_A}/maintenance/${FIXTURE_R.id}`);
    expect(
      await screen.findByRole('heading', {
        name: 'Fixed hallway light',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark resolved' }),
    ).not.toBeInTheDocument();
  });

  it('POSTs resolve with {} and updates detail + same-Home lists and Pulse only', async () => {
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
    let resolveCalls = 0;
    const fetchMock = stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_H]),
        [TEST_HOME_B]: listPage([]),
      },
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_H.id)]: detailFromListItem(
          FIXTURE_H,
          'Notes',
        ),
      },
      resolveByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_H.id)]: (body) => {
          resolveCalls += 1;
          expect(body).toEqual({});
          return resolved;
        },
      },
      resolveDelayMs: 40,
    });

    const { queryClient } = renderApp(
      `/homes/${TEST_HOME_A}/maintenance/${FIXTURE_H.id}`,
    );
    await queryClient.fetchQuery({
      queryKey: maintenanceKeys.list(TEST_HOME_B, {}),
      queryFn: () => Promise.resolve(listPage([])),
    });
    const otherBefore = queryClient.getQueryState(
      maintenanceKeys.list(TEST_HOME_B, {}),
    )?.dataUpdatedAt;
    queryClient.setQueryData(pulseKeys.all(TEST_HOME_A), clearHousePulse());
    queryClient.setQueryData(pulseKeys.all(TEST_HOME_B), clearHousePulse());
    const otherPulseBefore = queryClient.getQueryState(
      pulseKeys.all(TEST_HOME_B),
    )?.dataUpdatedAt;

    const button = await screen.findByRole('button', { name: 'Mark resolved' });
    await userEvent.click(button);
    expect(button).toBeDisabled();
    await waitFor(() => {
      expect(screen.getByText('Resolved')).toBeInTheDocument();
    });
    expect(resolveCalls).toBe(1);
    expect(
      queryClient.getQueryData(
        maintenanceKeys.detail(TEST_HOME_A, FIXTURE_H.id),
      ),
    ).toEqual(resolved);
    expect(
      queryClient.getQueryState(maintenanceKeys.list(TEST_HOME_B, {}))
        ?.dataUpdatedAt,
    ).toBe(otherBefore);
    await waitFor(() => {
      expect(
        queryClient.getQueryState(pulseKeys.all(TEST_HOME_A))?.isInvalidated,
      ).toBe(true);
    });
    expect(
      queryClient.getQueryState(pulseKeys.all(TEST_HOME_B))?.dataUpdatedAt,
    ).toBe(otherPulseBefore);
    expect(
      queryClient.getQueryState(pulseKeys.all(TEST_HOME_B))?.isInvalidated,
    ).not.toBe(true);
    expect(
      screen.queryByRole('button', { name: 'Mark resolved' }),
    ).not.toBeInTheDocument();

    const resolveRequest = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/resolve'),
    );
    expect(resolveRequest).toBeDefined();
    const resolveBody = (resolveRequest?.[1] as RequestInit | undefined)?.body;
    expect(typeof resolveBody).toBe('string');
    expect(JSON.parse(resolveBody as string)).toEqual({});
  });

  it('handles 409 MAINTENANCE_NOT_OPEN calmly and refetches', async () => {
    stubMaintenanceApis({
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_H.id)]: detailFromListItem(
          FIXTURE_H,
          null,
        ),
      },
      resolveByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_H.id)]: {
          status: 409,
          body: {
            error: {
              code: 'MAINTENANCE_NOT_OPEN',
              message: 'not open',
            },
          },
        },
      },
    });

    renderApp(`/homes/${TEST_HOME_A}/maintenance/${FIXTURE_H.id}`);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Mark resolved' }),
    );
    expect(
      await screen.findByText('This item has already been resolved.'),
    ).toBeInTheDocument();
    expect(screen.queryAllByText(/scary|forbidden|permission/i)).toHaveLength(
      0,
    );
  });

  it('privacy negative: resolve 404 clears protected PRIVATE detail from DOM', async () => {
    const protectedTitle = 'Quiet leak under sink';
    const protectedDetails = 'Keep this between us.\nSecret line.';
    stubMaintenanceApis({
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_A.id)]: detailFromListItem(
          FIXTURE_A,
          protectedDetails,
        ),
      },
      resolveByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_A.id)]: {
          status: 404,
          body: notFoundBody(),
        },
      },
    });

    const { queryClient } = renderApp(
      `/homes/${TEST_HOME_A}/maintenance/${FIXTURE_A.id}`,
    );
    expect(
      await screen.findByRole('heading', { name: protectedTitle, level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Keep this between us/)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: 'Mark resolved' }),
    );

    expect(
      await screen.findByRole('heading', {
        name: 'Maintenance item unavailable',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(protectedTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(/Keep this between us/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Secret line/)).not.toBeInTheDocument();
    expect(screen.queryByText('Private')).not.toBeInTheDocument();
    expect(
      queryClient.getQueryData(
        maintenanceKeys.detail(TEST_HOME_A, FIXTURE_A.id),
      ),
    ).toBeUndefined();
  });

  it('does not role-gate Resolve or disclose audience', async () => {
    stubMaintenanceApis({
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_A.id)]: detailFromListItem(
          FIXTURE_A,
          'Protected',
        ),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance/${FIXTURE_A.id}`);
    expect(
      await screen.findByRole('button', { name: 'Mark resolved' }),
    ).toBeInTheDocument();
    expect(
      screen.queryAllByText(/admin|only creators|permission/i),
    ).toHaveLength(0);
    expect(screen.queryByText(/audience|shared with/i)).not.toBeInTheDocument();
  });
});
