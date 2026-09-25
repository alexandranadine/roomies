import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';
import { maintenanceKeys } from './maintenance-query-keys.js';
import {
  detailFromListItem,
  FIXTURE_A,
  FIXTURE_B_ID,
  FIXTURE_B_TITLE,
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

function assertNoPrivacyLeaks(container: HTMLElement = document.body) {
  const text = container.textContent ?? '';
  expect(text).not.toMatch(/hidden item|hidden count|1 hidden/i);
  expect(text).not.toMatch(/private item unavailable/i);
  expect(text).not.toMatch(/you don't have permission/i);
  expect(text).not.toMatch(/audience|shared with/i);
  expect(text).not.toContain(FIXTURE_B_TITLE);
  expect(text).not.toContain(FIXTURE_B_ID);
  expect(text).not.toContain(TEST_MEMBERSHIP_A);
}

describe('Maintenance list page', () => {
  it('reaches Maintenance from Home navigation and keeps the route Home-scoped', async () => {
    const user = userEvent.setup();
    stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_H]),
      },
    });
    const { router } = renderApp(`/homes/${TEST_HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();

    await user.click(await screen.findByRole('link', { name: 'Open Maintenance' }));

    expect(
      await screen.findByRole('heading', { name: 'Maintenance', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      `/homes/${TEST_HOME_A}/maintenance`,
    );
    expect(
      await screen.findByRole('link', { name: /Replace furnace filter/i }),
    ).toBeInTheDocument();
  });

  it('renders visible items in server order without list details', async () => {
    stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_H, FIXTURE_A, FIXTURE_R]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);

    const furnace = await screen.findByRole('link', {
      name: /Replace furnace filter/i,
    });
    const leak = screen.getByRole('link', { name: /Quiet leak under sink/i });
    const light = screen.getByRole('link', { name: /Fixed hallway light/i });

    const links = screen
      .getAllByRole('link')
      .filter((el) =>
        /Replace furnace|Quiet leak|Fixed hallway/.test(el.textContent ?? ''),
      );
    expect(links[0]).toBe(furnace);
    expect(links[1]).toBe(leak);
    expect(links[2]).toBe(light);

    expect(screen.queryByText(/Under the cabinet/i)).not.toBeInTheDocument();
    assertNoPrivacyLeaks();
  });

  it('critical privacy: authorized H+A only — no B, hidden UI, or audience', async () => {
    stubMaintenanceApis({
      listByHome: {
        // Authorized projection only. B is absent from the response.
        [TEST_HOME_A]: listPage([FIXTURE_H, FIXTURE_A]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);

    expect(
      await screen.findByRole('link', { name: /Replace furnace filter/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Quiet leak under sink/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Private')).toBeInTheDocument();

    expect(screen.queryByText(FIXTURE_B_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText(/hidden/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
    assertNoPrivacyLeaks();
  });

  it('shows HOUSEHOLD, PRIVATE, and RESOLVED list treatments', async () => {
    stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_H, FIXTURE_A, FIXTURE_R]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);

    await screen.findByRole('link', { name: /Replace furnace filter/i });

    const householdRow = screen.getByRole('link', {
      name: /Replace furnace filter/i,
    });
    expect(within(householdRow).getByText('Open')).toBeInTheDocument();
    expect(within(householdRow).queryByText('Private')).not.toBeInTheDocument();

    const privateRow = screen.getByRole('link', {
      name: /Quiet leak under sink/i,
    });
    expect(within(privateRow).getByText('Private')).toBeInTheDocument();
    expect(within(privateRow).getByText('Open')).toBeInTheDocument();

    const resolvedRow = screen.getByRole('link', {
      name: /Fixed hallway light/i,
    });
    expect(within(resolvedRow).getByText('Resolved')).toBeInTheDocument();
  });

  it('wraps long titles without exposing Membership IDs', async () => {
    const longTitle =
      'Take the overflowing recycling and compost bins from the side alley every Wednesday evening';
    stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: listPage([
          { ...FIXTURE_H, title: longTitle },
          FIXTURE_A,
        ]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);

    expect(
      await screen.findByRole('link', { name: new RegExp(longTitle, 'i') }),
    ).toBeInTheDocument();
    expect(screen.getByText('Private')).toBeInTheDocument();
    assertNoPrivacyLeaks();
  });

  it('maps All/Open/Resolved filters to the correct backend status query', async () => {
    const user = userEvent.setup();
    const fetchMock = stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: (url) => {
          const status = url.searchParams.get('status');
          if (status === 'OPEN') {
            return listPage([FIXTURE_H, FIXTURE_A]);
          }
          if (status === 'RESOLVED') {
            return listPage([FIXTURE_R]);
          }
          return listPage([FIXTURE_H, FIXTURE_A, FIXTURE_R]);
        },
      },
    });
    const { router } = renderApp(`/homes/${TEST_HOME_A}/maintenance`);

    await screen.findByRole('link', { name: /Replace furnace filter/i });

    await user.click(screen.getByRole('button', { name: 'Open' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('?status=OPEN');
    });
    await waitFor(() => {
      const openCalls = fetchMock.mock.calls.filter((call) => {
        const url = new URL(String(call[0]));
        return (
          url.pathname.endsWith(`/homes/${TEST_HOME_A}/maintenance`) &&
          url.searchParams.get('status') === 'OPEN'
        );
      });
      expect(openCalls.length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByRole('link', { name: /Fixed hallway light/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resolved' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('?status=RESOLVED');
    });
    expect(
      await screen.findByRole('link', { name: /Fixed hallway light/i }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
  });

  it('shows valid empty states without hidden-item copy', async () => {
    const user = userEvent.setup();
    stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: listPage([]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);

    expect(
      await screen.findByRole('heading', {
        name: 'Nothing needs attention right now.',
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Household maintenance items will show up here.'),
    ).toBeInTheDocument();
    assertNoPrivacyLeaks();

    await user.click(screen.getByRole('button', { name: 'Open' }));
    expect(
      await screen.findByRole('heading', {
        name: 'Nothing needs attention right now.',
        level: 2,
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Resolved' }));
    expect(
      await screen.findByRole('heading', {
        name: 'No resolved items yet.',
        level: 2,
      }),
    ).toBeInTheDocument();
  });

  it('uses nextCursor for Load more and hides the control when hasMore is false', async () => {
    const user = userEvent.setup();
    const fetchMock = stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: (url) => {
          const cursor = url.searchParams.get('cursor');
          if (cursor === 'cursor-page-2') {
            return listPage([FIXTURE_R], { hasMore: false, nextCursor: null });
          }
          return listPage([FIXTURE_H], {
            hasMore: true,
            nextCursor: 'cursor-page-2',
          });
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);

    expect(
      await screen.findByRole('link', { name: /Replace furnace filter/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Fixed hallway light/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(
      await screen.findByRole('link', { name: /Fixed hallway light/i }),
    ).toBeInTheDocument();

    const loadMoreCalls = fetchMock.mock.calls.filter((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get('cursor') === 'cursor-page-2';
    });
    expect(loadMoreCalls.length).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: 'Load more' }),
    ).not.toBeInTheDocument();
  });

  it('treats list-scope 404 as Home unavailable, not a valid empty list', async () => {
    stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: () => ({ status: 404, body: notFoundBody() }),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);

    expect(
      await screen.findByRole('heading', {
        name: 'This Home isn’t available',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', {
        name: 'Nothing needs attention right now.',
      }),
    ).not.toBeInTheDocument();
  });

  it('shows retry UI for transient list errors without raw backend privacy copy', async () => {
    stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: () => ({
          status: 500,
          body: {
            error: {
              code: 'INTERNAL_ERROR',
              message: 'PRIVATE audience membership leaked',
            },
          },
        }),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);

    expect(
      await screen.findByText(/Couldn’t load maintenance/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(
      screen.queryByText(/PRIVATE audience membership leaked/i),
    ).not.toBeInTheDocument();
  });

  it('opens detail from a visible list row', async () => {
    const user = userEvent.setup();
    stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_H]),
      },
      detailByKey: {
        [detailCacheKey(TEST_HOME_A, FIXTURE_H.id)]: detailFromListItem(
          FIXTURE_H,
          'Use the MERV-13 filters in the closet.',
        ),
      },
    });
    const { router } = renderApp(`/homes/${TEST_HOME_A}/maintenance`);

    await user.click(
      await screen.findByRole('link', { name: /Replace furnace filter/i }),
    );

    expect(
      await screen.findByRole('heading', {
        name: 'Replace furnace filter',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      `/homes/${TEST_HOME_A}/maintenance/${FIXTURE_H.id}`,
    );
  });

  it('does not render Home A maintenance content for Home B', async () => {
    stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_H, FIXTURE_A]),
        [TEST_HOME_B]: listPage([FIXTURE_R]),
      },
    });
    const { router, queryClient } = renderApp(
      `/homes/${TEST_HOME_A}/maintenance`,
    );

    expect(
      await screen.findByRole('link', { name: /Replace furnace filter/i }),
    ).toBeInTheDocument();
    expect(
      queryClient.getQueryData(maintenanceKeys.list(TEST_HOME_A)),
    ).toBeDefined();

    await router.navigate(`/homes/${TEST_HOME_B}/maintenance`);

    expect(
      await screen.findByRole('link', { name: /Fixed hallway light/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Replace furnace filter/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /Quiet leak under sink/i }),
    ).not.toBeInTheDocument();
    expect(maintenanceKeys.list(TEST_HOME_B)[1]).toBe(TEST_HOME_B);
  });

  it('exposes accessible filter controls and Private text', async () => {
    stubMaintenanceApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_A]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/maintenance`);

    expect(
      await screen.findByRole('group', { name: 'Filter by status' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      screen.getByRole('navigation', { name: 'Home' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Private')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /Quiet leak under sink/i }),
    ).toBeInTheDocument();
  });
});
