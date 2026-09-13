import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
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
  TEST_MEMBERSHIP_A,
} from './test-fixtures.js';
import { detailCacheKey, stubMaintenanceApis } from './test-stub.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Maintenance detail page', () => {
  it('renders visible HOUSEHOLD detail with plain-text details', async () => {
    stubMaintenanceApis({
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_H.id)]: detailFromListItem(
          FIXTURE_H,
          'Line one.\nLine two.',
        ),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance/${FIXTURE_H.id}`);

    expect(
      await screen.findByRole('heading', {
        name: 'Replace furnace filter',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.queryByText('Private')).not.toBeInTheDocument();
    expect(screen.getByText(/Line one\./)).toBeInTheDocument();
    expect(screen.getByText(/Line two\./)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('dangerouslySetInnerHTML');
    expect(screen.queryByText(TEST_MEMBERSHIP_A)).not.toBeInTheDocument();
  });

  it('renders visible PRIVATE detail with accessible Private indicator', async () => {
    stubMaintenanceApis({
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_A.id)]: detailFromListItem(
          FIXTURE_A,
          'Keep this between us.',
        ),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance/${FIXTURE_A.id}`);

    expect(
      await screen.findByRole('heading', {
        name: 'Quiet leak under sink',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Private')).toBeInTheDocument();
    expect(screen.getByText('Keep this between us.')).toBeInTheDocument();
    expect(screen.queryByText(/audience|shared with/i)).not.toBeInTheDocument();
    expect(screen.queryByText(TEST_MEMBERSHIP_A)).not.toBeInTheDocument();
  });

  it('handles null details safely', async () => {
    stubMaintenanceApis({
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_H.id)]: detailFromListItem(
          FIXTURE_H,
          null,
        ),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance/${FIXTURE_H.id}`);

    expect(
      await screen.findByRole('heading', {
        name: 'Replace furnace filter',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Details' }),
    ).not.toBeInTheDocument();
  });

  it('shows resolved metadata without resolver Membership IDs', async () => {
    stubMaintenanceApis({
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_R.id)]: detailFromListItem(
          FIXTURE_R,
          null,
        ),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance/${FIXTURE_R.id}`);

    expect(
      await screen.findByRole('heading', {
        name: 'Fixed hallway light',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    expect(screen.getByText('Resolved at')).toBeInTheDocument();
    expect(
      screen.queryByText(FIXTURE_R.resolvedByMembershipId ?? 'missing'),
    ).not.toBeInTheDocument();
  });

  it('uses one generic unavailable state for detail 404', async () => {
    stubMaintenanceApis({
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_A.id)]: {
          status: 404,
          body: {
            error: {
              code: 'NOT_FOUND',
              message: 'This PRIVATE entry is hidden from you',
            },
          },
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance/${FIXTURE_A.id}`);

    expect(
      await screen.findByRole('heading', {
        name: 'Maintenance item unavailable',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('It may no longer be available.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/permission|private|hidden|another Home/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/This PRIVATE entry is hidden from you/i),
    ).not.toBeInTheDocument();
  });

  it('treats nonexistent and invisible the same at the UI level', async () => {
    stubMaintenanceApis({});
    renderApp(
      `/homes/${TEST_HOME_A}/maintenance/ffffffff-ffff-4fff-8fff-ffffffffffff`,
    );

    expect(
      await screen.findByRole('heading', {
        name: 'Maintenance item unavailable',
        level: 1,
      }),
    ).toBeInTheDocument();
  });

  it('does not transplant a detail id across Home context', async () => {
    stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_H]),
        [TEST_HOME_B]: listPage([]),
      },
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_H.id)]: detailFromListItem(
          FIXTURE_H,
          'Home A details',
        ),
      },
    });
    const { router, queryClient } = renderApp(
      `/homes/${TEST_HOME_A}/maintenance/${FIXTURE_H.id}`,
    );

    expect(
      await screen.findByRole('heading', {
        name: 'Replace furnace filter',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      queryClient.getQueryData(
        maintenanceKeys.detail(TEST_HOME_A, FIXTURE_H.id),
      ),
    ).toBeDefined();

    await router.navigate(`/homes/${TEST_HOME_B}/maintenance/${FIXTURE_H.id}`);

    expect(
      await screen.findByRole('heading', {
        name: 'Maintenance item unavailable',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Home A details')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Replace furnace filter'),
    ).not.toBeInTheDocument();
    expect(maintenanceKeys.detail(TEST_HOME_B, FIXTURE_H.id)[1]).toBe(
      TEST_HOME_B,
    );
  });

  it('does not keep previous Home detail visible while the next route loads', async () => {
    stubMaintenanceApis({
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_H.id)]: detailFromListItem(
          FIXTURE_H,
          'Home A only',
        ),
        [detailCacheKey(TEST_HOME_B, FIXTURE_R.id)]: detailFromListItem(
          { ...FIXTURE_R, title: 'Cedar resolved light' },
          'Home B only',
        ),
      },
      detailDelayMs: 40,
    });
    const { router } = renderApp(
      `/homes/${TEST_HOME_A}/maintenance/${FIXTURE_H.id}`,
    );

    expect(
      await screen.findByRole('heading', {
        name: 'Replace furnace filter',
        level: 1,
      }),
    ).toBeInTheDocument();

    await router.navigate(`/homes/${TEST_HOME_B}/maintenance/${FIXTURE_R.id}`);

    await waitFor(() => {
      expect(screen.queryByText('Home A only')).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: 'Replace furnace filter' }),
      ).not.toBeInTheDocument();
    });

    expect(
      await screen.findByRole('heading', {
        name: 'Cedar resolved light',
        level: 1,
      }),
    ).toBeInTheDocument();
  });
});

describe('Maintenance query retry behavior', () => {
  it('does not automatically retry detail 404', async () => {
    const fetchMock = stubMaintenanceApis({
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_H.id)]: {
          status: 404,
          body: notFoundBody(),
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance/${FIXTURE_H.id}`);

    expect(
      await screen.findByRole('heading', {
        name: 'Maintenance item unavailable',
        level: 1,
      }),
    ).toBeInTheDocument();

    const detailCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes(`/maintenance/${FIXTURE_H.id}`),
    );
    expect(detailCalls).toHaveLength(1);
  });
});
