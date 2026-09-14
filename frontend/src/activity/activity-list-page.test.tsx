import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';
import { activityKeys } from './activity-query-keys.js';
import {
  activityItem,
  FIXTURE_HOME_B_TASK,
  FIXTURE_JOINED,
  FIXTURE_LEFT,
  FIXTURE_MAINTENANCE_CREATED,
  FIXTURE_MAINTENANCE_RESOLVED,
  FIXTURE_ROLE_CHANGED,
  FIXTURE_SUPPLY_GENERIC,
  FIXTURE_SUPPLY_TITLED,
  FIXTURE_TASK_GENERIC,
  FIXTURE_TASK_TITLED,
  listPage,
  notFoundBody,
  SOURCE_MAINTENANCE_ID,
  SOURCE_SUPPLY_ID,
  SOURCE_TASK_ID,
  TEST_HOME_A,
  TEST_HOME_B,
  TEST_MEMBERSHIP_ALEX,
  TEST_MEMBERSHIP_JAMIE,
  TEST_MEMBERSHIP_TAYLOR,
  TEST_USER_ID,
  unauthenticatedBody,
} from './test-fixtures.js';
import { stubActivityApis } from './test-stub.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

function assertNoIdentityLeaks(container: HTMLElement = document.body) {
  const text = container.textContent ?? '';
  expect(text).not.toContain(TEST_MEMBERSHIP_ALEX);
  expect(text).not.toContain(TEST_MEMBERSHIP_JAMIE);
  expect(text).not.toContain(TEST_MEMBERSHIP_TAYLOR);
  expect(text).not.toContain(SOURCE_TASK_ID);
  expect(text).not.toContain(SOURCE_SUPPLY_ID);
  expect(text).not.toContain(SOURCE_MAINTENANCE_ID);
  expect(text).not.toContain(TEST_USER_ID);
  expect(text).not.toMatch(
    /ActivityRecipient|sourceEntity|eventType|visibilityClass/i,
  );
  expect(text).not.toMatch(/audience|HOUSEHOLD|PRIVATE|Protected/i);
}

describe('Activity list page', () => {
  it('reaches Activity from Home navigation and keeps the route Home-scoped', async () => {
    const user = userEvent.setup();
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_TASK_TITLED]),
      },
    });
    const { router } = renderApp(`/homes/${TEST_HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Activity' }));

    expect(
      await screen.findByRole('heading', { name: 'Activity', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(
      `/homes/${TEST_HOME_A}/activity`,
    );
    expect(
      await screen.findByText('Alex completed Take out trash'),
    ).toBeInTheDocument();
  });

  it('renders the initial page in server order without client sorting', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([
          FIXTURE_TASK_TITLED,
          FIXTURE_SUPPLY_TITLED,
          FIXTURE_JOINED,
        ]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    const list = await screen.findByRole('list', { name: 'Home activity' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Alex completed Take out trash');
    expect(items[1]).toHaveTextContent('Alex marked Paper towels obtained');
    expect(items[2]).toHaveTextContent('Jamie joined the home');
    expect(
      screen.getByText('Recent things happening around the home.'),
    ).toBeInTheDocument();
    assertNoIdentityLeaks();
  });

  it('renders all seven current event types', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([
          FIXTURE_JOINED,
          FIXTURE_LEFT,
          FIXTURE_ROLE_CHANGED,
          FIXTURE_TASK_TITLED,
          FIXTURE_TASK_GENERIC,
          FIXTURE_SUPPLY_TITLED,
          FIXTURE_SUPPLY_GENERIC,
          FIXTURE_MAINTENANCE_CREATED,
          FIXTURE_MAINTENANCE_RESOLVED,
        ]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByText('Jamie joined the home'),
    ).toBeInTheDocument();
    expect(screen.getByText('Jamie left the home')).toBeInTheDocument();
    expect(
      screen.getByText("Taylor updated Jamie's home role"),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Alex completed Take out trash'),
    ).toBeInTheDocument();
    expect(screen.getByText('Alex completed a task')).toBeInTheDocument();
    expect(
      screen.getByText('Alex marked Paper towels obtained'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Alex marked a supply obtained'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Alex added a maintenance item'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Alex resolved a maintenance item'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Quiet leak under sink')).not.toBeInTheDocument();
    assertNoIdentityLeaks();
  });

  it('uses Former roommate for null names and never shows membership IDs', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([
          activityItem({
            id: 'n1111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            actor: { membershipId: TEST_MEMBERSHIP_ALEX, name: null },
          }),
          activityItem({
            id: 'n2222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            eventType: 'membership.started.v1',
            sourceEntityType: 'MEMBERSHIP',
            sourceTitle: null,
            actor: null,
            subject: { membershipId: TEST_MEMBERSHIP_JAMIE, name: null },
          }),
        ]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByText('Former roommate completed Take out trash'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Former roommate joined the home'),
    ).toBeInTheDocument();
    assertNoIdentityLeaks();
  });

  it('does not infer removal copy from actor/subject difference', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_LEFT]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(await screen.findByText('Jamie left the home')).toBeInTheDocument();
    expect(screen.queryByText(/removed|Taylor/)).not.toBeInTheDocument();
  });

  it('does not render Maintenance titles, audience, visibility, or PRIVATE badges', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([
          FIXTURE_MAINTENANCE_CREATED,
          FIXTURE_MAINTENANCE_RESOLVED,
        ]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByText('Alex added a maintenance item'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Alex resolved a maintenance item'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Quiet leak under sink')).not.toBeInTheDocument();
    expect(screen.queryByText('Private')).not.toBeInTheDocument();
    expect(screen.queryByText('HOUSEHOLD')).not.toBeInTheDocument();
    expect(screen.queryByText(/audience/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /maintenance item/i }),
    ).not.toBeInTheDocument();
    assertNoIdentityLeaks();
  });

  it('shows the empty state without sample events', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByRole('heading', { name: 'No activity yet', level: 2 }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Updates from your home will show up here.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Home activity' }),
    ).not.toBeInTheDocument();
  });

  it('treats list-scope 404 as Home unavailable', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: () => ({ status: 404, body: notFoundBody() }),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByRole('heading', {
        name: 'This Home isn’t available',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'No activity yet' }),
    ).not.toBeInTheDocument();
  });

  it('routes list 401 into the existing auth-loss flow', async () => {
    let meStatus = 200;
    stubActivityApis({
      meStatus: () => meStatus,
      listByHome: {
        [TEST_HOME_A]: () => {
          meStatus = 401;
          return { status: 401, body: unauthenticatedBody() };
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByText('Sign in to see your Homes.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Alex completed Take out trash'),
    ).not.toBeInTheDocument();
  });

  it('shows retry UI for an initial transient error without backend details', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: () => ({
          status: 500,
          body: {
            error: {
              code: 'INTERNAL_ERROR',
              message: 'cursor abc123 leaked',
            },
          },
        }),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByText(/Couldn’t load activity/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/cursor abc123 leaked/i)).not.toBeInTheDocument();
  });

  it('does not persist Activity cache to storage', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_TASK_TITLED]),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByText('Alex completed Take out trash'),
    ).toBeInTheDocument();

    const stored = `${JSON.stringify(localStorage)} ${JSON.stringify(sessionStorage)}`;
    expect(stored).not.toContain('Take out trash');
    expect(stored).not.toContain(FIXTURE_TASK_TITLED.id);
    expect(stored).not.toContain('/activity');
  });
});

describe('Activity pagination', () => {
  it('uses nextCursor for Load more, appends in server order, and hides when done', async () => {
    const user = userEvent.setup();
    const fetchMock = stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: (url) => {
          const cursor = url.searchParams.get('cursor');
          if (cursor === 'cursor-page-2') {
            return listPage([FIXTURE_SUPPLY_TITLED, FIXTURE_JOINED], {
              hasMore: false,
              nextCursor: null,
            });
          }
          return listPage([FIXTURE_TASK_TITLED], {
            hasMore: true,
            nextCursor: 'cursor-page-2',
          });
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByText('Alex completed Take out trash'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Alex marked Paper towels obtained'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(
      await screen.findByText('Alex marked Paper towels obtained'),
    ).toBeInTheDocument();

    const list = screen.getByRole('list', { name: 'Home activity' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Alex completed Take out trash'),
      expect.stringContaining('Alex marked Paper towels obtained'),
      expect.stringContaining('Jamie joined the home'),
    ]);

    const loadMoreCalls = fetchMock.mock.calls.filter((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get('cursor') === 'cursor-page-2';
    });
    expect(loadMoreCalls.length).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: 'Load more' }),
    ).not.toBeInTheDocument();
  });

  it('does not request another page when nextCursor is null', async () => {
    const fetchMock = stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_TASK_TITLED], {
          hasMore: true,
          nextCursor: null,
        }),
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByText('Alex completed Take out trash'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Load more' }),
    ).not.toBeInTheDocument();

    const activityCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/activity'),
    );
    expect(activityCalls).toHaveLength(1);
  });

  it('preserves loaded rows when Load more fails and retries the same cursor', async () => {
    const user = userEvent.setup();
    let pageTwoAttempts = 0;
    const fetchMock = stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: (url) => {
          const cursor = url.searchParams.get('cursor');
          if (cursor === 'cursor-page-2') {
            pageTwoAttempts += 1;
            if (pageTwoAttempts === 1) {
              return {
                status: 400,
                body: {
                  error: {
                    code: 'INVALID_REQUEST',
                    message: 'invalid cursor xyz',
                  },
                },
              };
            }
            return listPage([FIXTURE_JOINED], {
              hasMore: false,
              nextCursor: null,
            });
          }
          return listPage([FIXTURE_TASK_TITLED], {
            hasMore: true,
            nextCursor: 'cursor-page-2',
          });
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByText('Alex completed Take out trash'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(
      await screen.findByText(/Couldn’t load more activity/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Alex completed Take out trash'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/invalid cursor xyz/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(
      await screen.findByText('Jamie joined the home'),
    ).toBeInTheDocument();
    const retryCalls = fetchMock.mock.calls.filter((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get('cursor') === 'cursor-page-2';
    });
    expect(retryCalls.length).toBe(2);
  });

  it('prevents a duplicate Load more request while a fetch is in flight', async () => {
    const user = userEvent.setup();
    const fetchMock = stubActivityApis({
      listDelayMs: 80,
      delayedHomeId: TEST_HOME_A,
      listByHome: {
        [TEST_HOME_A]: (url) => {
          const cursor = url.searchParams.get('cursor');
          if (cursor === 'cursor-page-2') {
            return listPage([FIXTURE_JOINED], {
              hasMore: false,
              nextCursor: null,
            });
          }
          return listPage([FIXTURE_TASK_TITLED], {
            hasMore: true,
            nextCursor: 'cursor-page-2',
          });
        },
      },
    });
    renderApp(`/homes/${TEST_HOME_A}/activity`);

    const loadMore = await screen.findByRole('button', { name: 'Load more' });
    await user.click(loadMore);
    expect(loadMore).toBeDisabled();
    await user.click(loadMore);

    await waitFor(() => {
      expect(screen.getByText('Jamie joined the home')).toBeInTheDocument();
    });

    const laterCalls = fetchMock.mock.calls.filter((call) => {
      const url = new URL(String(call[0]));
      return url.searchParams.get('cursor') === 'cursor-page-2';
    });
    expect(laterCalls.length).toBe(1);
  });
});

describe('Activity Home isolation', () => {
  it('does not append or flash Home A rows while Home B loads', async () => {
    stubActivityApis({
      listDelayMs: 60,
      delayedHomeId: TEST_HOME_B,
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_TASK_TITLED]),
        [TEST_HOME_B]: listPage([FIXTURE_HOME_B_TASK]),
      },
    });
    const { router, queryClient } = renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByText('Alex completed Take out trash'),
    ).toBeInTheDocument();
    expect(
      queryClient.getQueryData(activityKeys.list(TEST_HOME_A)),
    ).toBeDefined();

    await router.navigate(`/homes/${TEST_HOME_B}/activity`);

    await waitFor(() => {
      expect(
        screen.queryByText('Alex completed Take out trash'),
      ).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Take out trash')).not.toBeInTheDocument();

    expect(
      await screen.findByText('Casey completed Water the plants'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Alex completed Take out trash'),
    ).not.toBeInTheDocument();
    expect(activityKeys.list(TEST_HOME_B)[1]).toBe(TEST_HOME_B);
  });

  it('restores Home-scoped cache when switching back', async () => {
    stubActivityApis({
      listByHome: {
        [TEST_HOME_A]: listPage([FIXTURE_TASK_TITLED]),
        [TEST_HOME_B]: listPage([FIXTURE_HOME_B_TASK]),
      },
    });
    const { router, queryClient } = renderApp(`/homes/${TEST_HOME_A}/activity`);

    expect(
      await screen.findByText('Alex completed Take out trash'),
    ).toBeInTheDocument();

    await router.navigate(`/homes/${TEST_HOME_B}/activity`);
    expect(
      await screen.findByText('Casey completed Water the plants'),
    ).toBeInTheDocument();

    await router.navigate(`/homes/${TEST_HOME_A}/activity`);
    expect(
      await screen.findByText('Alex completed Take out trash'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Casey completed Water the plants'),
    ).not.toBeInTheDocument();
    expect(
      queryClient.getQueryData(activityKeys.list(TEST_HOME_A)),
    ).toBeDefined();
    expect(
      queryClient.getQueryData(activityKeys.list(TEST_HOME_B)),
    ).toBeDefined();
  });
});
