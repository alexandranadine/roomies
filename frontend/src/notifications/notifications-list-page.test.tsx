import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetApiClientForTests } from '../platform/api/index.js';
import { renderApp } from '../test/render.js';
import { notificationKeys } from './notifications-query-keys.js';
import {
  FIXTURE_HOME_B_TASK,
  FIXTURE_PRIVATE_CREATED,
  FIXTURE_PRIVATE_RESOLVED,
  FIXTURE_READ_TASK,
  FIXTURE_ROLE_CHANGED,
  FIXTURE_SUPPLY_GENERIC,
  FIXTURE_SUPPLY_TITLED,
  FIXTURE_TASK_GENERIC,
  FIXTURE_TASK_TITLED,
  listPage,
  notFoundBody,
  TEST_HOME_A,
  TEST_HOME_B,
  TEST_MAINTENANCE_ID,
  TEST_SUPPLY_ID,
  TEST_TASK_ID,
  TEST_USER_ID,
  unauthenticatedBody,
  notificationItem,
} from './test-fixtures.js';
import { stubNotificationsApis } from './test-stub.js';

afterEach(() => {
  resetApiClientForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

function assertNoIdentityLeaks(container: HTMLElement = document.body) {
  const text = container.textContent ?? '';
  expect(text).not.toContain(TEST_TASK_ID);
  expect(text).not.toContain(TEST_SUPPLY_ID);
  expect(text).not.toContain(TEST_MAINTENANCE_ID);
  expect(text).not.toContain(TEST_USER_ID);
  expect(text).not.toMatch(
    /MEMBERSHIP_ROLE_CHANGED|ASSIGNED_TASK_COMPLETED|CREATED_SUPPLY_OBTAINED|PRIVATE_MAINTENANCE_CREATED|PRIVATE_MAINTENANCE_RESOLVED/,
  );
  expect(text).not.toMatch(/audience|HOUSEHOLD|outbox|userId|email/i);
  expect(text).not.toContain('Quiet leak under sink');
}

describe('Notifications list page', () => {
  it('reaches Notifications from the global shell entry without a badge', async () => {
    const user = userEvent.setup();
    stubNotificationsApis({
      list: listPage([FIXTURE_TASK_TITLED]),
    });
    const { router } = renderApp(`/homes/${TEST_HOME_A}`);

    expect(
      await screen.findByRole('heading', { name: 'Oak Street', level: 1 }),
    ).toBeInTheDocument();

    const notificationsLink = await screen.findByRole('link', {
      name: /Notifications/,
    });
    expect(notificationsLink).toBeInTheDocument();

    await user.click(notificationsLink);

    expect(
      await screen.findByRole('heading', { name: 'Notifications', level: 1 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/notifications');
  });

  it('renders all five kinds in server order with Home names and no client re-sort', async () => {
    stubNotificationsApis({
      list: listPage([
        FIXTURE_ROLE_CHANGED,
        FIXTURE_TASK_TITLED,
        FIXTURE_TASK_GENERIC,
        FIXTURE_SUPPLY_TITLED,
        FIXTURE_SUPPLY_GENERIC,
        FIXTURE_PRIVATE_CREATED,
        FIXTURE_PRIVATE_RESOLVED,
        FIXTURE_HOME_B_TASK,
      ]),
    });
    renderApp('/notifications');

    const list = await screen.findByRole('list', { name: 'Notifications' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(8);
    expect(items[0]).toHaveTextContent('Your roommate role changed');
    expect(items[1]).toHaveTextContent('Alex completed a task assigned to you');
    expect(items[1]).toHaveTextContent('Take out trash');
    expect(items[2]).toHaveTextContent('A task assigned to you was completed');
    expect(items[3]).toHaveTextContent('Alex picked up a supply you added');
    expect(items[3]).toHaveTextContent('Paper towels');
    expect(items[4]).toHaveTextContent('A supply you added was picked up');
    expect(items[5]).toHaveTextContent('New private maintenance update');
    expect(items[6]).toHaveTextContent('Private maintenance was resolved');
    expect(items[7]).toHaveTextContent(
      'Casey completed a task assigned to you',
    );
    expect(items[7]).toHaveTextContent('Cedar House');
    expect(items[0]).toHaveTextContent('Oak Street');
    expect(screen.queryByText(/3 unread|0 unread/i)).not.toBeInTheDocument();
    assertNoIdentityLeaks();
  });

  it('distinguishes unread with accessible text and renders read normally', async () => {
    stubNotificationsApis({
      list: listPage([FIXTURE_TASK_TITLED, FIXTURE_READ_TASK]),
    });
    renderApp('/notifications');

    const list = await screen.findByRole('list', { name: 'Notifications' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toMatch(/Unread/);
    expect(items[1]?.textContent).not.toMatch(/Unread/);
    expect(
      screen.getByRole('button', {
        name: 'Unread. Alex completed a task assigned to you',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /^Alex completed a task assigned to you$/,
      }),
    ).toBeInTheDocument();
    expect(items[0]?.querySelector('time')).toHaveAttribute(
      'dateTime',
      FIXTURE_TASK_TITLED.occurredAt,
    );
    expect(items[1]?.querySelector('time')).toHaveAttribute(
      'dateTime',
      FIXTURE_READ_TASK.occurredAt,
    );
    expect(
      screen.queryByText(/unread count|3 unread/i),
    ).not.toBeInTheDocument();
  });

  it('wraps long notification copy without fabricating extra context', async () => {
    const longName =
      'Jamie With An Exceptionally Long Roommate Display Name For Wrapping';
    const longTitle =
      'Take out the overflowing recycling and compost bins from the side alley every Wednesday evening';
    stubNotificationsApis({
      list: listPage([
        notificationItem({
          actor: { name: longName },
          source: { type: 'TASK', title: longTitle },
        }),
      ]),
    });
    renderApp('/notifications');

    expect(
      await screen.findByText(`${longName} completed a task assigned to you`),
    ).toBeInTheDocument();
    expect(screen.getByText(longTitle)).toBeInTheDocument();
    expect(screen.getByText('Oak Street')).toBeInTheDocument();
    assertNoIdentityLeaks();
  });

  it('keeps the global bell unread count in sync with the inbox', async () => {
    stubNotificationsApis({
      list: listPage([
        FIXTURE_TASK_TITLED,
        FIXTURE_ROLE_CHANGED,
        FIXTURE_READ_TASK,
      ]),
    });
    renderApp('/notifications');

    expect(
      await screen.findByRole('link', { name: 'Notifications, 2 unread' }),
    ).toBeInTheDocument();
  });

  it('shows empty state without implying hidden notifications', async () => {
    stubNotificationsApis({ list: listPage([]) });
    renderApp('/notifications');

    expect(
      await screen.findByRole('heading', {
        name: 'You’re all caught up.',
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Household updates will show up here.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('list', { name: 'Notifications' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Mark all as read' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Notifications' }),
    ).toBeInTheDocument();
  });

  it('shows retry UI for an initial transient error without backend details', async () => {
    stubNotificationsApis({
      list: () => ({
        status: 500,
        body: {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'cursor abc123 leaked',
          },
        },
      }),
    });
    renderApp('/notifications');

    expect(
      await screen.findByText(/Couldn’t load notifications/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/cursor abc123 leaked/i)).not.toBeInTheDocument();
  });

  it('does not persist Notification cache to storage', async () => {
    stubNotificationsApis({
      list: listPage([FIXTURE_TASK_TITLED]),
    });
    renderApp('/notifications');

    expect(
      await screen.findByText('Alex completed a task assigned to you'),
    ).toBeInTheDocument();

    const stored = `${JSON.stringify(localStorage)} ${JSON.stringify(sessionStorage)}`;
    expect(stored).not.toContain('Take out trash');
    expect(stored).not.toContain(FIXTURE_TASK_TITLED.id);
    expect(stored).not.toContain('/notifications');
  });

  it('keeps the global Notification query key free of homeId across Home shells', async () => {
    stubNotificationsApis({
      list: listPage([FIXTURE_TASK_TITLED, FIXTURE_HOME_B_TASK]),
    });
    const { queryClient, router } = renderApp('/notifications');

    expect(
      await screen.findByText('Alex completed a task assigned to you'),
    ).toBeInTheDocument();

    const key = notificationKeys.list({});
    expect(key).toEqual(['notifications', 'list', {}]);
    expect(key).not.toContain(TEST_HOME_A);
    expect(queryClient.getQueryData(key)).toBeDefined();

    await router.navigate(`/homes/${TEST_HOME_B}`);
    expect(
      await screen.findByRole('heading', { name: 'Cedar House', level: 1 }),
    ).toBeInTheDocument();
    expect(queryClient.getQueryData(key)).toBeDefined();

    await router.navigate('/notifications');
    expect(
      await screen.findByText('Alex completed a task assigned to you'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Casey completed a task assigned to you'),
    ).toBeInTheDocument();
  });
});

describe('Notification pagination', () => {
  it('uses nextCursor for Load more and appends in server order', async () => {
    const user = userEvent.setup();
    const fetchMock = stubNotificationsApis({
      list: (url) => {
        const cursor = url.searchParams.get('cursor');
        if (cursor === 'cursor-page-2') {
          return listPage([FIXTURE_SUPPLY_TITLED, FIXTURE_HOME_B_TASK], {
            hasMore: false,
            nextCursor: null,
          });
        }
        return listPage([FIXTURE_TASK_TITLED], {
          hasMore: true,
          nextCursor: 'cursor-page-2',
        });
      },
    });
    renderApp('/notifications');

    expect(
      await screen.findByText('Alex completed a task assigned to you'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(
      await screen.findByText('Alex picked up a supply you added'),
    ).toBeInTheDocument();

    const list = screen.getByRole('list', { name: 'Notifications' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Alex completed a task assigned to you'),
      expect.stringContaining('Alex picked up a supply you added'),
      expect.stringContaining('Casey completed a task assigned to you'),
    ]);

    const loadMoreCalls = fetchMock.mock.calls.filter((call) => {
      const url = new URL(String(call[0]));
      return (
        url.pathname === '/api/v1/notifications' &&
        url.searchParams.get('cursor') === 'cursor-page-2'
      );
    });
    expect(loadMoreCalls.length).toBeGreaterThan(0);
  });

  it('preserves loaded rows when Load more fails and retries the same cursor', async () => {
    const user = userEvent.setup();
    let pageTwoAttempts = 0;
    stubNotificationsApis({
      list: (url) => {
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
          return listPage([FIXTURE_ROLE_CHANGED], {
            hasMore: false,
            nextCursor: null,
          });
        }
        return listPage([FIXTURE_TASK_TITLED], {
          hasMore: true,
          nextCursor: 'cursor-page-2',
        });
      },
    });
    renderApp('/notifications');

    expect(
      await screen.findByText('Alex completed a task assigned to you'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more' }));

    expect(
      await screen.findByText(/Couldn’t load more notifications/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Alex completed a task assigned to you'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/invalid cursor xyz/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByText('Your roommate role changed'),
    ).toBeInTheDocument();
  });
});

describe('Notification interactions', () => {
  it('marks one unread on activate without optimistic read, then navigates to destination Home', async () => {
    const user = userEvent.setup();
    let markOneCalls = 0;
    let listCalls = 0;
    const fetchMock = stubNotificationsApis({
      list: () => {
        listCalls += 1;
        if (listCalls === 1) {
          return listPage([FIXTURE_TASK_TITLED]);
        }
        return listPage([
          notificationItem({
            ...FIXTURE_TASK_TITLED,
            readAt: '2026-09-13T18:10:00.000Z',
          }),
        ]);
      },
      markOne: () => {
        markOneCalls += 1;
        expect(
          screen
            .getByText('Alex completed a task assigned to you')
            .closest('button')?.textContent,
        ).toMatch(/Unread/);
        return { status: 204 };
      },
    });
    const { router } = renderApp('/notifications');

    expect(
      await screen.findByText('Alex completed a task assigned to you'),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: 'Unread. Alex completed a task assigned to you',
      }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/homes/${TEST_HOME_A}`);
    });
    expect(markOneCalls).toBe(1);

    const markCalls = fetchMock.mock.calls.filter((call) => {
      const url = new URL(String(call[0]));
      return (
        url.pathname ===
          `/api/v1/notifications/${FIXTURE_TASK_TITLED.id}/read` &&
        (call[1] as RequestInit | undefined)?.method === 'POST'
      );
    });
    expect(markCalls).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes('/maintenance/'),
      ),
    ).toBe(false);
  });

  it('does not mark already-read rows merely by rendering or page open', async () => {
    const fetchMock = stubNotificationsApis({
      list: listPage([FIXTURE_READ_TASK, FIXTURE_ROLE_CHANGED]),
    });
    renderApp('/notifications');

    expect(
      await screen.findByText('Alex completed a task assigned to you'),
    ).toBeInTheDocument();
    expect(screen.getByText('Your roommate role changed')).toBeInTheDocument();

    const markCalls = fetchMock.mock.calls.filter((call) => {
      const url = new URL(String(call[0]));
      return url.pathname.includes('/read');
    });
    expect(markCalls).toHaveLength(0);
  });

  it('does not navigate on concealed mark-one 404 and refreshes the list', async () => {
    const user = userEvent.setup();
    let listCalls = 0;
    stubNotificationsApis({
      list: () => {
        listCalls += 1;
        if (listCalls === 1) {
          return listPage([FIXTURE_TASK_TITLED]);
        }
        return listPage([]);
      },
      markOne: { status: 404, body: notFoundBody() },
    });
    const { router } = renderApp('/notifications');

    expect(
      await screen.findByText('Alex completed a task assigned to you'),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: 'Unread. Alex completed a task assigned to you',
      }),
    );

    await waitFor(() => {
      expect(
        screen.queryByText('Alex completed a task assigned to you'),
      ).not.toBeInTheDocument();
    });
    expect(router.state.location.pathname).toBe('/notifications');
    expect(
      screen.queryByText(/permission|forbidden|not authorized/i),
    ).not.toBeInTheDocument();
  });

  it('navigates using destination Home for Supply and cross-Home Task', async () => {
    const user = userEvent.setup();
    stubNotificationsApis({
      list: listPage([
        notificationItem({
          ...FIXTURE_SUPPLY_TITLED,
          readAt: '2026-09-13T16:05:00.000Z',
          destination: {
            type: 'SUPPLY',
            homeId: TEST_HOME_B,
            supplyEntryId: TEST_SUPPLY_ID,
          },
          home: { id: TEST_HOME_B, name: 'Cedar House' },
        }),
      ]),
    });
    const { router } = renderApp('/notifications');

    expect(
      await screen.findByText('Alex picked up a supply you added'),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', {
        name: /Alex picked up a supply you added/i,
      }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/homes/${TEST_HOME_B}`);
    });
  });

  it('navigates Roommates to the destination Home Roommates route and HOME to overview', async () => {
    const user = userEvent.setup();
    stubNotificationsApis({
      list: listPage([
        notificationItem({
          ...FIXTURE_ROLE_CHANGED,
          readAt: '2026-09-13T18:01:00.000Z',
          destination: { type: 'ROOMMATES', homeId: TEST_HOME_B },
          home: { id: TEST_HOME_B, name: 'Cedar House' },
        }),
        notificationItem({
          ...FIXTURE_PRIVATE_CREATED,
          readAt: '2026-09-13T15:01:00.000Z',
          destination: { type: 'HOME', homeId: TEST_HOME_B },
          home: { id: TEST_HOME_B, name: 'Cedar House' },
        }),
      ]),
    });
    const { router } = renderApp('/notifications');

    await user.click(
      await screen.findByRole('button', {
        name: /Your roommate role changed/i,
      }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(
        `/homes/${TEST_HOME_B}/roommates`,
      );
    });

    await router.navigate('/notifications');
    await user.click(
      await screen.findByRole('button', {
        name: /New private maintenance update/i,
      }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/homes/${TEST_HOME_B}`);
    });
    expect(router.state.location.pathname).not.toContain('/maintenance');
  });

  it('invokes read-all without optimistic mass mutation or affected count', async () => {
    const user = userEvent.setup();
    let listCalls = 0;
    let readAllCalls = 0;
    stubNotificationsApis({
      list: () => {
        listCalls += 1;
        if (listCalls === 1) {
          return listPage([FIXTURE_TASK_TITLED, FIXTURE_ROLE_CHANGED]);
        }
        return listPage([
          notificationItem({
            ...FIXTURE_TASK_TITLED,
            readAt: '2026-09-13T18:10:00.000Z',
          }),
          notificationItem({
            ...FIXTURE_ROLE_CHANGED,
            readAt: '2026-09-13T18:10:00.000Z',
          }),
        ]);
      },
      readAll: () => {
        readAllCalls += 1;
        expect(screen.getAllByText(/Unread/i).length).toBeGreaterThan(0);
        return { status: 204 };
      },
    });
    renderApp('/notifications');

    expect(
      await screen.findByRole('button', { name: 'Mark all as read' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/\d+\s+unread|affected/i),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark all as read' }));

    await waitFor(() => {
      expect(readAllCalls).toBe(1);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Mark all as read' }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByText(/2 notifications|affected/i),
    ).not.toBeInTheDocument();
  });

  it('routes list 401 into the existing auth-loss flow and clears Notification cache', async () => {
    let meStatus = 200;
    stubNotificationsApis({
      meStatus: () => meStatus,
      list: () => {
        meStatus = 401;
        return { status: 401, body: unauthenticatedBody() };
      },
    });
    const { queryClient } = renderApp('/notifications');

    expect(
      await screen.findByRole('heading', { name: 'Welcome back', level: 1 }),
    ).toBeInTheDocument();
    expect(queryClient.getQueryData(notificationKeys.list({}))).toBeUndefined();
  });

  it('does not request Maintenance detail while rendering PRIVATE rows', async () => {
    const fetchMock = stubNotificationsApis({
      list: listPage([FIXTURE_PRIVATE_CREATED, FIXTURE_PRIVATE_RESOLVED]),
    });
    renderApp('/notifications');

    expect(
      await screen.findByText('New private maintenance update'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Private maintenance was resolved'),
    ).toBeInTheDocument();

    const maintenanceCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes('/maintenance'),
    );
    expect(maintenanceCalls).toHaveLength(0);
    assertNoIdentityLeaks();
  });
});
